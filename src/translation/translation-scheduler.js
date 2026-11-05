/**
 * translation/translation-scheduler.js
 * Translation Scheduler（Phase 3）。
 * 并发含义：同时执行的 API batch 数（默认 2，Options 可调 1–8，由本模块统一限流）。
 * 状态机（每任务）：pending → running → completed | failed | cancelled。
 * 停止语义（真实网络取消）：
 *  - 不再接受新任务；排队任务全部取消；
 *  - stop() 会 abort 每个正在运行任务的 AbortController → Provider 的 fetch 立即取消；
 *  - AbortError / USER_CANCELLED 不算失败、不重试；迟到结果不再回调。
 */
import { TranslationError, ERROR_CODES } from '../shared/errors.js';

/**
 * 通用有限并发队列：限制同时执行的任务数，支持整体取消。
 * 取消只影响排队中的任务；正在执行的任务由其自行尽快收尾。
 */
export class ConcurrencyLimiter {
  constructor(maxConcurrency = 2) {
    this.maxConcurrency = Math.max(1, maxConcurrency);
    this.running = 0;
    this.pending = []; // { task, resolve, reject }
    this.cancelled = false;
  }

  /** 提交一个异步任务，返回其结果的 Promise；并发数受 maxConcurrency 限制。 */
  run(task) {
    return new Promise((resolve, reject) => {
      this.pending.push({ task, resolve, reject });
      this.drain();
    });
  }

  drain() {
    while (!this.cancelled && this.running < this.maxConcurrency && this.pending.length > 0) {
      const { task, resolve, reject } = this.pending.shift();
      this.running += 1;
      Promise.resolve()
        .then(task)
        .then((value) => {
          this.running -= 1;
          resolve(value);
          this.drain();
        })
        .catch((err) => {
          this.running -= 1;
          reject(err);
          this.drain();
        });
    }
  }

  /** 取消所有排队中的任务（已在执行的任务由 Scheduler.stop() 负责 abort）。 */
  cancelAll() {
    this.cancelled = true;
    const err = new TranslationError(ERROR_CODES.USER_CANCELLED);
    while (this.pending.length > 0) {
      this.pending.shift().reject(err);
    }
  }

  reset() {
    this.cancelled = false;
  }
}

export class TranslationScheduler {
  constructor({ maxConcurrency = 2 } = {}) {
    this.limiter = new ConcurrencyLimiter(maxConcurrency);
    this.tasks = new Map(); // taskId -> { id, status, startedAt, finishedAt, controller }
    this.stopped = false;
  }

  getTask(taskId) {
    return this.tasks.get(taskId) ?? null;
  }

  /** 各状态任务计数（用于完成判定；块级进度由调用方自行统计）。 */
  stats() {
    const s = { total: 0, pending: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
    for (const t of this.tasks.values()) {
      s.total += 1;
      s[t.status] += 1;
    }
    return s;
  }

  /**
   * 提交单个任务（幂等：同一 taskId 不重复排队）。
   * execute(signal)：真正执行翻译的函数；signal 在 stop() 时被 abort，
   *   执行方（Provider fetch）必须把该信号传给网络请求。
   * onResult / onError：任务完成或失败时回调（stop 后不再回调）。
   */
  schedule({ taskId, execute, onResult, onError }) {
    if (this.tasks.has(taskId)) return Promise.resolve();
    const task = {
      id: taskId,
      status: 'pending',
      startedAt: null,
      finishedAt: null,
      controller: new AbortController(),
    };
    this.tasks.set(taskId, task);
    return this.limiter
      .run(async () => {
        task.status = 'running';
        task.startedAt = Date.now();
        const value = await execute(task.controller.signal);
        task.status = 'completed';
        task.finishedAt = Date.now();
        return value;
      })
      .then((value) => {
        if (this.stopped) {
          // 停止后才完成：结果不回调（execute 内部已把结果写入会话缓存，供重新开始时复用）
          task.status = 'cancelled';
          return;
        }
        onResult(value);
      })
      .catch((err) => {
        const cancelled =
          this.stopped ||
          (err && (err.code === ERROR_CODES.USER_CANCELLED || err.name === 'AbortError'));
        if (cancelled) {
          task.status = 'cancelled'; // 用户停止 / abort：不算失败、不重试
          return;
        }
        task.status = 'failed';
        onError(err);
      });
  }

  /**
   * 停止：拒绝新任务；取消排队；abort 所有正在执行的任务（真实取消网络请求）；
   * 迟到结果不再回调。
   */
  stop() {
    this.stopped = true;
    for (const task of this.tasks.values()) {
      if (task.status === 'running') {
        try {
          task.controller.abort();
        } catch {
          /* 已完成任务的 controller abort 是 no-op */
        }
      }
    }
    this.limiter.cancelAll();
  }
}
