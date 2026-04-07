/**
 * 随机生成器工具
 * 生成随机数、随机字符串、UUID、密码、颜色等
 */

/**
 * 工具定义（OpenAI 格式）
 */
export const randomGeneratorTool = {
    name: 'random_generator',
    description: '随机生成器。支持类型: number（数字）, string（字符串）, uuid（UUID）, password（密码）, color（颜色）, boolean（布尔值）, choice（选择）。',
    parameters: {
        type: 'object',
        properties: {
            type: {
                type: 'string',
                enum: ['number', 'string', 'uuid', 'password', 'color', 'boolean', 'choice', 'array'],
                description: '生成类型'
            },
            min: {
                type: 'number',
                description: '最小值（用于 number 类型）'
            },
            max: {
                type: 'number',
                description: '最大值（用于 number 类型）'
            },
            length: {
                type: 'number',
                description: '长度（用于 string/password 类型）'
            },
            charset: {
                type: 'string',
                enum: ['alphanumeric', 'alphabetic', 'numeric', 'lowercase', 'uppercase', 'symbols', 'hex'],
                description: '字符集（用于 string 类型）'
            },
            include_symbols: {
                type: 'boolean',
                description: '是否包含符号（用于 password 类型）'
            },
            include_numbers: {
                type: 'boolean',
                description: '是否包含数字（用于 password 类型）'
            },
            include_uppercase: {
                type: 'boolean',
                description: '是否包含大写字母（用于 password 类型）'
            },
            format: {
                type: 'string',
                enum: ['hex', 'rgb', 'hsl'],
                description: '颜色格式（用于 color 类型）'
            },
            choices: {
                type: 'array',
                items: { type: 'string' },
                description: '选择列表（用于 choice 类型）'
            },
            count: {
                type: 'number',
                description: '生成数量（用于 array 类型）'
            }
        },
        required: ['type']
    }
};

/**
 * 工具处理器
 * @param {Object} args - 参数
 * @returns {Promise<Object>} 生成结果
 */
export async function randomGeneratorHandler(args) {
    const { type, min, max, length, charset, include_symbols, include_numbers, include_uppercase, format, choices, count } = args;

    console.log(`[RandomGenerator] 生成类型: ${type}`, args);

    try {
        let result;
        let metadata = {};

        switch (type) {
            case 'number': {
                const minVal = min !== undefined ? min : 0;
                const maxVal = max !== undefined ? max : 100;
                result = generateRandomNumber(minVal, maxVal);
                metadata = { min: minVal, max: maxVal, is_integer: Number.isInteger(result) };
                break;
            }

            case 'string': {
                const strLength = length || 10;
                const strCharset = charset || 'alphanumeric';
                result = generateRandomString(strLength, strCharset);
                metadata = { length: strLength, charset: strCharset };
                break;
            }

            case 'uuid':
                result = generateUUID();
                metadata = { version: 4, variant: 'RFC 4122' };
                break;

            case 'password': {
                const pwdLength = length || 16;
                const pwdOptions = {
                    symbols: include_symbols !== false,
                    numbers: include_numbers !== false,
                    uppercase: include_uppercase !== false
                };
                result = generatePassword(pwdLength, pwdOptions);
                metadata = { length: pwdLength, ...pwdOptions };
                break;
            }

            case 'color': {
                const colorFormat = format || 'hex';
                result = generateRandomColor(colorFormat);
                metadata = { format: colorFormat };
                break;
            }

            case 'boolean':
                result = Math.random() < 0.5;
                metadata = { probability: 0.5 };
                break;

            case 'choice':
                if (!choices || !Array.isArray(choices) || choices.length === 0) {
                    throw new Error('choice 类型需要非空的 choices 数组');
                }
                result = choices[Math.floor(Math.random() * choices.length)];
                metadata = { choices, total_choices: choices.length };
                break;

            case 'array': {
                const arrayCount = count || 5;
                const arrayType = args.array_type || 'number';
                result = generateRandomArray(arrayCount, arrayType, args);
                metadata = { count: arrayCount, array_type: arrayType };
                break;
            }

            default:
                throw new Error(`不支持的生成类型: ${type}`);
        }

        return {
            type,
            success: true,
            result,
            metadata,
            timestamp: Date.now()
        };

    } catch (error) {
        console.error(`[RandomGenerator] 错误:`, error);
        throw new Error(`随机生成失败: ${error.message}`);
    }
}

/**
 * 生成随机数
 * @param {number} min - 最小值
 * @param {number} max - 最大值
 * @returns {number}
 */
function generateRandomNumber(min, max) {
    // 如果 min 和 max 都是整数，返回整数
    if (Number.isInteger(min) && Number.isInteger(max)) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }
    // 否则返回浮点数
    return Math.random() * (max - min) + min;
}

/**
 * 生成随机字符串
 * @param {number} length - 长度
 * @param {string} charset - 字符集类型
 * @returns {string}
 */
function generateRandomString(length, charset) {
    const charsets = {
        alphanumeric: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
        alphabetic: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
        numeric: '0123456789',
        lowercase: 'abcdefghijklmnopqrstuvwxyz',
        uppercase: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
        symbols: '!@#$%^&*()_+-=[]{}|;:,.<>?',
        hex: '0123456789abcdef'
    };

    const chars = charsets[charset] || charsets.alphanumeric;
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

/**
 * 生成 UUID v4
 * @returns {string}
 */
function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

/**
 * 生成随机密码
 * @param {number} length - 长度
 * @param {Object} options - 选项
 * @returns {string}
 */
function generatePassword(length, options) {
    let charset = 'abcdefghijklmnopqrstuvwxyz';

    if (options.uppercase) {
        charset += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    }
    if (options.numbers) {
        charset += '0123456789';
    }
    if (options.symbols) {
        charset += '!@#$%^&*()_+-=[]{}|;:,.<>?';
    }

    let password = '';
    for (let i = 0; i < length; i++) {
        password += charset.charAt(Math.floor(Math.random() * charset.length));
    }

    // 确保至少包含一个要求的字符类型
    if (options.uppercase && !/[A-Z]/.test(password)) {
        password = password.substring(0, length - 1) + 'A';
    }
    if (options.numbers && !/[0-9]/.test(password)) {
        password = password.substring(0, length - 1) + '1';
    }
    if (options.symbols && !/[!@#$%^&*()_+\-=[\]{}|;:,.<>?]/.test(password)) {
        password = password.substring(0, length - 1) + '!';
    }

    return password;
}

/**
 * 生成随机颜色
 * @param {string} format - 格式
 * @returns {string}
 */
function generateRandomColor(format) {
    const r = Math.floor(Math.random() * 256);
    const g = Math.floor(Math.random() * 256);
    const b = Math.floor(Math.random() * 256);

    switch (format) {
        case 'hex':
            return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
        case 'rgb':
            return `rgb(${r}, ${g}, ${b})`;
        case 'hsl': {
            const { h, s, l } = rgbToHsl(r, g, b);
            return `hsl(${h}, ${s}%, ${l}%)`;
        }
        default:
            return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
    }
}

/**
 * RGB 转 HSL
 * @param {number} r - 红色
 * @param {number} g - 绿色
 * @param {number} b - 蓝色
 * @returns {Object}
 */
function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s;
    const l = (max + min) / 2;

    if (max === min) {
        h = s = 0;
    } else {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
            case g: h = ((b - r) / d + 2) / 6; break;
            case b: h = ((r - g) / d + 4) / 6; break;
        }
    }

    return {
        h: Math.round(h * 360),
        s: Math.round(s * 100),
        l: Math.round(l * 100)
    };
}

/**
 * 生成随机数组
 * @param {number} count - 数量
 * @param {string} arrayType - 数组元素类型
 * @param {Object} args - 参数
 * @returns {Array}
 */
function generateRandomArray(count, arrayType, args) {
    const result = [];
    for (let i = 0; i < count; i++) {
        switch (arrayType) {
            case 'number':
                result.push(generateRandomNumber(args.min || 0, args.max || 100));
                break;
            case 'string':
                result.push(generateRandomString(args.length || 8, args.charset || 'alphanumeric'));
                break;
            case 'uuid':
                result.push(generateUUID());
                break;
            case 'boolean':
                result.push(Math.random() < 0.5);
                break;
            default:
                result.push(generateRandomNumber(0, 100));
        }
    }
    return result;
}

console.log('[RandomGenerator Tool] 🎲 随机生成器工具已加载');

// ========== 标准化工具对象 ==========

import { buildToolFromLegacy } from '../build-tool.js';

export const randomGenerator = buildToolFromLegacy('random_generator', randomGeneratorTool, randomGeneratorHandler, { isReadOnly: () => true });
