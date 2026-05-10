/**
 * 提供商 UI 共享状态
 * 从 ui.js 提取，避免 provider-form.js / provider-list.js / model-selector.js 与 ui.js 循环依赖
 */

// 当前选中的提供商 ID
let selectedProviderId = null;

export function getSelectedProviderId() {
    return selectedProviderId;
}

export function setSelectedProviderId(id) {
    selectedProviderId = id;
}
