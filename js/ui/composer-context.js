import { state } from '../core/state.js';
import { eventBus } from '../core/events.js';
import { getCurrentProvider, getModelDisplayName } from '../providers/manager.js';

const FEATURE_LABELS = [
    ['streamEnabled', '流式'],
    ['webSearchEnabled', '联网'],
    ['thinkingEnabled', '思维链'],
    ['codeExecutionEnabled', '代码'],
    ['computerUseEnabled', '控制'],
    ['monitorEnabled', '监控']
];

let isRendering = false;

function getElements() {
    return {
        model: document.getElementById('composer-model-name'),
        provider: document.getElementById('composer-provider-name'),
        features: document.getElementById('composer-feature-status'),
        summary: document.getElementById('composer-model-summary')
    };
}

function getSelectedModel() {
    return state.selectedModel || document.getElementById('model-select')?.value || '';
}

export function renderComposerContext() {
    if (isRendering) return;
    isRendering = true;

    try {
        const { model, provider, features } = getElements();
        if (!model || !provider || !features) return;

        const selectedModel = getSelectedModel();
        const currentProvider = selectedModel ? getCurrentProvider() : null;
        const displayName = getModelDisplayName(selectedModel, currentProvider);

        model.textContent = selectedModel ? displayName : '未选择模型';
        provider.textContent = currentProvider?.name || '配置模型后开始';
        provider.title = currentProvider?.apiFormat ? currentProvider.apiFormat.toUpperCase() : '';

        features.replaceChildren();
        const activeFeatures = FEATURE_LABELS.filter(([key]) => state[key]);
        if (activeFeatures.length === 0) {
            const idle = document.createElement('span');
            idle.className = 'composer-feature-idle';
            idle.textContent = '标准模式';
            features.appendChild(idle);
            return;
        }

        activeFeatures.forEach(([, label]) => {
            const pill = document.createElement('span');
            pill.className = 'composer-feature-pill';
            pill.textContent = label;
            features.appendChild(pill);
        });
    } finally {
        isRendering = false;
    }
}

export function initComposerContext() {
    const { summary } = getElements();
    summary?.addEventListener('click', () => {
        document.getElementById('settings-toggle')?.click();
    });

    const update = () => renderComposerContext();
    [
        'state:selectedModel',
        'state:currentProviderId',
        'state:streamEnabled',
        'state:webSearchEnabled',
        'state:thinkingEnabled',
        'state:codeExecutionEnabled',
        'state:computerUseEnabled',
        'state:monitorEnabled',
        'providers:updated',
        'providers:switched',
        'providers:models-changed',
        'config:sync-quick-toggles'
    ].forEach((event) => eventBus.on(event, update));

    update();
}
