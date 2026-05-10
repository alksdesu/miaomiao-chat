/**
 * 色盘组件
 * Canvas 绘制的 HSV 颜色选择器
 */

/* ===== 颜色数学 ===== */

export function hsvToRgb(h, s, v) {
    h = ((h % 360) + 360) % 360;
    s = Math.max(0, Math.min(1, s));
    v = Math.max(0, Math.min(1, v));

    const c = v * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = v - c;

    let r, g, b;
    if (h < 60) {
        r = c;
        g = x;
        b = 0;
    } else if (h < 120) {
        r = x;
        g = c;
        b = 0;
    } else if (h < 180) {
        r = 0;
        g = c;
        b = x;
    } else if (h < 240) {
        r = 0;
        g = x;
        b = c;
    } else if (h < 300) {
        r = x;
        g = 0;
        b = c;
    } else {
        r = c;
        g = 0;
        b = x;
    }

    return {
        r: Math.round((r + m) * 255),
        g: Math.round((g + m) * 255),
        b: Math.round((b + m) * 255)
    };
}

export function rgbToHsv(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;

    let h = 0;
    if (d !== 0) {
        if (max === r) h = 60 * (((g - b) / d) % 6);
        else if (max === g) h = 60 * ((b - r) / d + 2);
        else h = 60 * ((r - g) / d + 4);
    }
    if (h < 0) h += 360;

    const s = max === 0 ? 0 : d / max;
    return { h, s, v: max };
}

export function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('');
}

export function hexToRgb(hex) {
    const h = hex.replace('#', '');
    if (h.length === 3) {
        return {
            r: parseInt(h[0] + h[0], 16),
            g: parseInt(h[1] + h[1], 16),
            b: parseInt(h[2] + h[2], 16)
        };
    }
    if (h.length >= 6) {
        return {
            r: parseInt(h.substring(0, 2), 16),
            g: parseInt(h.substring(2, 4), 16),
            b: parseInt(h.substring(4, 6), 16)
        };
    }
    return null;
}

export function parseColor(str) {
    if (!str || typeof str !== 'string') return { r: 0, g: 0, b: 0, a: 1 };
    const s = str.trim();

    // #hex
    if (s.startsWith('#')) {
        const rgb = hexToRgb(s);
        if (rgb) {
            // hex8 透明度
            const h = s.replace('#', '');
            const a =
                h.length === 8
                    ? parseInt(h.substring(6, 8), 16) / 255
                    : h.length === 4
                      ? parseInt(h[3] + h[3], 16) / 255
                      : 1;
            return { ...rgb, a: Math.round(a * 100) / 100 };
        }
    }

    // rgba(r, g, b, a) or rgb(r, g, b) — 含逗号和空格/斜杠语法
    const m = s.match(
        /^rgba?\(\s*(\d+)\s*[,\s]\s*(\d+)\s*[,\s]\s*(\d+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/
    );
    if (m) {
        let a = 1;
        if (m[4] != null) {
            a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
        }
        return { r: parseInt(m[1]), g: parseInt(m[2]), b: parseInt(m[3]), a };
    }

    // 兜底：用 canvas 解析命名色、hsl 等
    try {
        const ctx = document.createElement('canvas').getContext('2d');
        ctx.fillStyle = s;
        const parsed = ctx.fillStyle;
        if (parsed.startsWith('#')) {
            const rgb = hexToRgb(parsed);
            if (rgb) return { ...rgb, a: 1 };
        }
        const m2 = parsed.match(
            /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/
        );
        if (m2) {
            return {
                r: parseInt(m2[1]),
                g: parseInt(m2[2]),
                b: parseInt(m2[3]),
                a: m2[4] != null ? parseFloat(m2[4]) : 1
            };
        }
    } catch {
        /* 解析失败 */
    }

    return { r: 0, g: 0, b: 0, a: 1 };
}

export function rgbaToString(r, g, b, a) {
    if (a >= 1) return rgbToHex(r, g, b);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/* ===== 最近使用色 ===== */

const RECENT_KEY = 'themeRecentColors';
const MAX_RECENT = 8;

function loadRecentColors() {
    try {
        const raw = localStorage.getItem(RECENT_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
}

function saveRecentColor(color) {
    const recent = loadRecentColors().filter((c) => c !== color);
    recent.unshift(color);
    if (recent.length > MAX_RECENT) recent.length = MAX_RECENT;
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
}

/* ===== Canvas 绘制 ===== */

function drawSvSquare(ctx, width, height, hue) {
    // 底色：纯色相
    const { r, g, b } = hsvToRgb(hue, 1, 1);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(0, 0, width, height);

    // 水平白色渐变（saturation）
    const whiteGrad = ctx.createLinearGradient(0, 0, width, 0);
    whiteGrad.addColorStop(0, 'rgba(255,255,255,1)');
    whiteGrad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = whiteGrad;
    ctx.fillRect(0, 0, width, height);

    // 垂直黑色渐变（value）
    const blackGrad = ctx.createLinearGradient(0, 0, 0, height);
    blackGrad.addColorStop(0, 'rgba(0,0,0,0)');
    blackGrad.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.fillStyle = blackGrad;
    ctx.fillRect(0, 0, width, height);
}

function drawHueStrip(ctx, width, height) {
    const grad = ctx.createLinearGradient(0, 0, width, 0);
    for (let i = 0; i <= 6; i++) {
        const { r, g, b } = hsvToRgb(i * 60, 1, 1);
        grad.addColorStop(i / 6, `rgb(${r},${g},${b})`);
    }
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);
}

function drawAlphaStrip(ctx, width, height, r, g, b) {
    // 棋盘格背景
    const size = 6;
    for (let y = 0; y < height; y += size) {
        for (let x = 0; x < width; x += size) {
            ctx.fillStyle = (x / size + y / size) % 2 === 0 ? '#ccc' : '#fff';
            ctx.fillRect(x, y, size, size);
        }
    }

    // 透明度渐变
    const grad = ctx.createLinearGradient(0, 0, width, 0);
    grad.addColorStop(0, `rgba(${r},${g},${b},0)`);
    grad.addColorStop(1, `rgba(${r},${g},${b},1)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);
}

/* ===== 指示器绘制 ===== */

function drawCircleIndicator(ctx, x, y, radius) {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, radius + 1, 0, Math.PI * 2);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.stroke();
}

function drawSliderIndicator(ctx, x, height) {
    ctx.beginPath();
    ctx.rect(x - 3, 0, 6, height);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.stroke();
}

/* ===== 色盘组件 ===== */

const SV_SIZE = 200;
const STRIP_W = 200;
const STRIP_H = 16;

/**
 * 打开色盘
 * @param {HTMLElement} anchor - 定位锚点
 * @param {string} initialColor - 初始颜色
 * @param {Function} onChange - 每次颜色变化回调
 * @param {Function} onClose - 关闭时回调（最终颜色）
 * @returns {{ destroy: Function }}
 */
export function openColorPicker(anchor, initialColor, onChange, onClose) {
    const ac = new AbortController();
    const signal = ac.signal;

    // 解析初始颜色
    const parsed = parseColor(initialColor);
    const initHsv = rgbToHsv(parsed.r, parsed.g, parsed.b);
    let hue = initHsv.h;
    let sat = initHsv.s;
    let val = initHsv.v;
    let alpha = parsed.a;

    // 创建 DOM
    const el = document.createElement('div');
    el.className = 'color-picker';
    // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
    el.innerHTML = `
        <canvas class="cp-sv" width="${SV_SIZE}" height="${SV_SIZE}"></canvas>
        <canvas class="cp-hue" width="${STRIP_W}" height="${STRIP_H}"></canvas>
        <canvas class="cp-alpha" width="${STRIP_W}" height="${STRIP_H}"></canvas>
        <div class="cp-inputs">
            <label class="cp-input-group">
                <span>#</span>
                <input class="cp-hex" type="text" maxlength="6" spellcheck="false">
            </label>
            <label class="cp-input-group">
                <span>R</span><input class="cp-r" type="number" min="0" max="255">
            </label>
            <label class="cp-input-group">
                <span>G</span><input class="cp-g" type="number" min="0" max="255">
            </label>
            <label class="cp-input-group">
                <span>B</span><input class="cp-b" type="number" min="0" max="255">
            </label>
            <label class="cp-input-group">
                <span>A</span><input class="cp-a" type="number" min="0" max="100">
            </label>
        </div>
        <div class="cp-swatches cp-preset-swatches"></div>
        <div class="cp-swatches cp-recent-swatches"></div>
    `;

    // Canvas 引用
    const svCanvas = el.querySelector('.cp-sv');
    const hueCanvas = el.querySelector('.cp-hue');
    const alphaCanvas = el.querySelector('.cp-alpha');
    const svCtx = svCanvas.getContext('2d');
    const hueCtx = hueCanvas.getContext('2d');
    const alphaCtx = alphaCanvas.getContext('2d');

    // 输入框引用
    const hexInput = el.querySelector('.cp-hex');
    const rInput = el.querySelector('.cp-r');
    const gInput = el.querySelector('.cp-g');
    const bInput = el.querySelector('.cp-b');
    const aInput = el.querySelector('.cp-a');

    // 预设色板
    const presetContainer = el.querySelector('.cp-preset-swatches');
    const presetColors = [
        '#0EA5E9',
        '#0284C7',
        '#FBBF24',
        '#F97316',
        '#14B8A6',
        '#22C55E',
        '#EF4444',
        '#84CC16',
        '#EC4899',
        '#E57373',
        '#FFFFFF',
        '#000000'
    ];
    presetColors.forEach((c) => {
        const swatch = document.createElement('button');
        swatch.className = 'cp-swatch';
        swatch.style.background = c;
        swatch.title = c;
        swatch.addEventListener(
            'click',
            () => {
                const rgb = hexToRgb(c);
                if (rgb) {
                    const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
                    hue = hsv.h;
                    sat = hsv.s;
                    val = hsv.v;
                    alpha = 1;
                    redraw();
                    emitChange();
                }
            },
            { signal }
        );
        presetContainer.appendChild(swatch);
    });

    // 最近使用色
    function renderRecent() {
        const recentContainer = el.querySelector('.cp-recent-swatches');
        // eslint-disable-next-line no-restricted-syntax -- 已审计：静态HTML/已escapeHtml/safeMarkedParse输出
        recentContainer.innerHTML = '';
        loadRecentColors().forEach((c) => {
            const swatch = document.createElement('button');
            swatch.className = 'cp-swatch';
            swatch.style.background = c;
            swatch.title = c;
            swatch.addEventListener(
                'click',
                () => {
                    const p = parseColor(c);
                    const hsv = rgbToHsv(p.r, p.g, p.b);
                    hue = hsv.h;
                    sat = hsv.s;
                    val = hsv.v;
                    alpha = p.a;
                    redraw();
                    emitChange();
                },
                { signal }
            );
            recentContainer.appendChild(swatch);
        });
    }

    // 计算当前颜色
    function currentColor() {
        const { r, g, b } = hsvToRgb(hue, sat, val);
        return rgbaToString(r, g, b, Math.round(alpha * 100) / 100);
    }

    function currentRgb() {
        return hsvToRgb(hue, sat, val);
    }

    function updateInputs() {
        const { r, g, b } = currentRgb();
        hexInput.value = rgbToHex(r, g, b).substring(1);
        rInput.value = r;
        gInput.value = g;
        bInput.value = b;
        aInput.value = Math.round(alpha * 100);
    }

    function emitChange() {
        updateInputs();
        onChange?.(currentColor());
    }

    // 绘制
    function redraw() {
        const { r, g, b } = currentRgb();

        // SV 方块
        drawSvSquare(svCtx, SV_SIZE, SV_SIZE, hue);
        drawCircleIndicator(svCtx, sat * SV_SIZE, (1 - val) * SV_SIZE, 6);

        // 色相条
        drawHueStrip(hueCtx, STRIP_W, STRIP_H);
        drawSliderIndicator(hueCtx, (hue / 360) * STRIP_W, STRIP_H);

        // 透明度条
        drawAlphaStrip(alphaCtx, STRIP_W, STRIP_H, r, g, b);
        drawSliderIndicator(alphaCtx, alpha * STRIP_W, STRIP_H);

        updateInputs();
    }

    // 拖拽逻辑（坐标归一化到 canvas 内部像素尺寸）
    function addDrag(canvas, onMove) {
        let dragging = false;

        function getPos(e) {
            const rect = canvas.getBoundingClientRect();
            const touch = e.touches?.[0] || e;
            // 用 CSS 渲染尺寸归一化到 canvas 内部坐标
            const scaleX = canvas.width / rect.width;
            const scaleY = canvas.height / rect.height;
            const rawX = touch.clientX - rect.left;
            const rawY = touch.clientY - rect.top;
            return {
                x: Math.max(0, Math.min(canvas.width, rawX * scaleX)),
                y: Math.max(0, Math.min(canvas.height, rawY * scaleY))
            };
        }

        function start(e) {
            e.preventDefault();
            dragging = true;
            onMove(getPos(e));
            redraw();
            emitChange();
        }

        function move(e) {
            if (!dragging) return;
            e.preventDefault();
            onMove(getPos(e));
            redraw();
            emitChange();
        }

        function end() {
            dragging = false;
        }

        canvas.addEventListener('mousedown', start, { signal });
        canvas.addEventListener('touchstart', start, { passive: false, signal });
        document.addEventListener('mousemove', move, { signal });
        document.addEventListener('touchmove', move, { passive: false, signal });
        document.addEventListener('mouseup', end, { signal });
        document.addEventListener('touchend', end, { signal });
    }

    // SV 拖拽
    addDrag(svCanvas, ({ x, y }) => {
        sat = x / SV_SIZE;
        val = 1 - y / SV_SIZE;
    });

    // 色相拖拽
    addDrag(hueCanvas, ({ x }) => {
        hue = (x / STRIP_W) * 360;
    });

    // 透明度拖拽
    addDrag(alphaCanvas, ({ x }) => {
        alpha = x / STRIP_W;
    });

    // 输入框事件
    function onHexChange() {
        const v = hexInput.value.trim();
        const rgb = hexToRgb(v.startsWith('#') ? v : '#' + v);
        if (rgb) {
            const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
            hue = hsv.h;
            sat = hsv.s;
            val = hsv.v;
            redraw();
            emitChange();
        }
    }

    function onRgbChange() {
        const r = Math.max(0, Math.min(255, parseInt(rInput.value) || 0));
        const g = Math.max(0, Math.min(255, parseInt(gInput.value) || 0));
        const b = Math.max(0, Math.min(255, parseInt(bInput.value) || 0));
        const hsv = rgbToHsv(r, g, b);
        hue = hsv.h;
        sat = hsv.s;
        val = hsv.v;
        redraw();
        emitChange();
    }

    function onAlphaInputChange() {
        alpha = Math.max(0, Math.min(100, parseInt(aInput.value) || 0)) / 100;
        redraw();
        emitChange();
    }

    hexInput.addEventListener('change', onHexChange, { signal });
    rInput.addEventListener('change', onRgbChange, { signal });
    gInput.addEventListener('change', onRgbChange, { signal });
    bInput.addEventListener('change', onRgbChange, { signal });
    aInput.addEventListener('change', onAlphaInputChange, { signal });

    // 定位
    function positionPicker() {
        const anchorRect = anchor.getBoundingClientRect();
        const pickerWidth = el.offsetWidth || 232;
        const pickerHeight = el.offsetHeight || 360;

        let top = anchorRect.bottom + 8;
        let left = anchorRect.left;

        // 屏幕碰撞检测
        if (top + pickerHeight > window.innerHeight) {
            top = anchorRect.top - pickerHeight - 8;
        }
        if (left + pickerWidth > window.innerWidth) {
            left = window.innerWidth - pickerWidth - 8;
        }
        if (left < 8) left = 8;
        if (top < 8) top = 8;

        el.style.top = `${top}px`;
        el.style.left = `${left}px`;
    }

    // 关闭
    function close() {
        const color = currentColor();
        saveRecentColor(color);
        onClose?.(color);
        destroy();
    }

    function destroy() {
        ac.abort();
        el.remove();
    }

    // 点击外部关闭
    setTimeout(() => {
        document.addEventListener(
            'mousedown',
            (e) => {
                if (!el.contains(e.target) && !anchor.contains(e.target)) {
                    close();
                }
            },
            { signal }
        );
    }, 0);

    // ESC 关闭
    document.addEventListener(
        'keydown',
        (e) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                close();
            }
        },
        { signal }
    );

    // 挂载
    document.body.appendChild(el);
    positionPicker();
    renderRecent();
    redraw();

    return { destroy };
}
