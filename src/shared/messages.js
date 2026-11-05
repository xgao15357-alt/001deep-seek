/**
 * shared/messages.js
 * ES Module 侧的消息协议封装（Service Worker / Popup / Options 使用）。
 * 常量本体在 messages.core.js（双模式文件），本文件只做再导出 + Promise 化发送，
 * 保证与 Content Script 使用同一份事实来源，不存在字符串手工同步问题。
 */
import './messages.core.js';

const NS = globalThis.__AIWT__;

export const MESSAGE_TYPES = NS.MESSAGE_TYPES;
export const LIMITS = NS.LIMITS;

export function makeMessage(type, payload = {}) {
  return NS.makeMessage(type, payload);
}

export function isKnownMessage(message) {
  return NS.isKnownMessage(message);
}

/**
 * Promise 化 sendMessage。
 * 后台统一返回 { ok, data?, error? } 结构；通信异常走 reject。
 */
export function sendRuntimeMessage(type, payload = {}) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(makeMessage(type, payload), (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}
