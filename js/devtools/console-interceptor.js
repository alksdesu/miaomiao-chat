/**
 * Console 日志捕获 — hook 全局 console 方法，维护循环缓冲区
 */

import { eventBus } from '../core/events.js';

const MAX_ENTRIES = 500;
const entries = [];
const originals = {};
const LEVELS = ['debug', 'info', 'log', 'warn', 'error'];
let nextId = 1;
let installed = false;
let capturing = false;

function serialize(args) {
    return args
        .map((a) =>
            typeof a === 'string'
                ? a
                : (() => {
                      try {
                          return JSON.stringify(a, null, 2);
                      } catch {
                          return String(a);
                      }
                  })()
        )
        .join(' ');
}

function capture(level, args) {
    // 防止自递归（eventBus 监听器内部可能调用 console）
    if (capturing) return;
    capturing = true;
    try {
        captureInner(level, args);
    } finally {
        capturing = false;
    }
}

function captureInner(level, args) {
    const entry = {
        id: nextId++,
        timestamp: Date.now(),
        level,
        message: serialize(args)
    };
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) entries.shift();
    eventBus.emit('devtools:console-entry', entry);
}

export function installConsoleInterceptor() {
    if (installed) return;
    for (const level of LEVELS) {
        originals[level] = console[level];
        console[level] = (...args) => {
            capture(level, args);
            originals[level].apply(console, args);
        };
    }
    installed = true;
}

export function uninstallConsoleInterceptor() {
    if (!installed) return;
    for (const level of LEVELS) {
        if (originals[level]) {
            console[level] = originals[level];
        }
    }
    installed = false;
}

export function getConsoleEntries(filter) {
    if (filter?.level) {
        return entries.filter((e) => e.level === filter.level);
    }
    return [...entries];
}

export function clearConsoleEntries() {
    const count = entries.length;
    entries.length = 0;
    return count;
}
