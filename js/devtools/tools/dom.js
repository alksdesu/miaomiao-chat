/**
 * DevTools DOM 查询工具 — CSS 选择器查询元素
 */

import { state } from '../../core/state.js';
import { buildToolFromLegacy } from '../../tools/build-tool.js';

const DEFAULT_STYLE_PROPS = [
    'display',
    'position',
    'width',
    'height',
    'margin',
    'padding',
    'color',
    'background-color',
    'font-size',
    'visibility',
    'opacity',
    'overflow',
    'z-index'
];

export const queryDomTool = {
    name: 'devtools_query_dom',
    description:
        'Query DOM elements using a CSS selector. Returns element details including tag, attributes, text content, and optionally computed styles.',
    parameters: {
        type: 'object',
        properties: {
            selector: {
                type: 'string',
                description: 'CSS selector'
            },
            includeStyles: {
                type: 'boolean',
                description: 'Include computed styles'
            },
            styleProperties: {
                type: 'array',
                items: { type: 'string' },
                description: 'CSS properties to include'
            }
        },
        required: ['selector']
    }
};

export async function queryDomHandler(args) {
    const sessionId = state.currentSessionId;

    const elements = document.querySelectorAll(args.selector);
    const results = [];
    const limit = Math.min(elements.length, 20);

    for (let i = 0; i < limit; i++) {
        const el = elements[i];
        const info = {
            tagName: el.tagName.toLowerCase(),
            id: el.id || undefined,
            className: el.className || undefined,
            attributes: Object.fromEntries([...el.attributes].map((a) => [a.name, a.value])),
            textContent: el.textContent?.slice(0, 500),
            boundingRect: (() => {
                const r = el.getBoundingClientRect();
                return {
                    top: r.top,
                    left: r.left,
                    width: r.width,
                    height: r.height,
                    bottom: r.bottom,
                    right: r.right
                };
            })()
        };

        if (args.includeStyles) {
            const computed = window.getComputedStyle(el);
            const props = args.styleProperties?.length ? args.styleProperties : DEFAULT_STYLE_PROPS;
            info.styles = {};
            for (const prop of props) {
                info.styles[prop] = computed.getPropertyValue(prop);
            }
        }

        results.push(info);
    }

    if (state.currentSessionId !== sessionId) {
        return { error: 'Session switched during operation' };
    }
    return { elements: results, count: elements.length, returned: results.length };
}

// ========== 标准化工具对象 ==========

export const queryDom = buildToolFromLegacy('devtools_query_dom', queryDomTool, queryDomHandler, {
    isReadOnly: () => true
});
