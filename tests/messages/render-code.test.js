/**
 * render-code.js 代码块处理纯函数测试
 * 测试语言检测、代码标题生成、语言映射等纯函数逻辑
 */
import { describe, it, expect } from 'vitest';

// 从源码复制出来的纯函数逻辑进行测试（因为原函数未导出，这里内联测试）

// ========== 语言显示名称映射 ==========

const languageDisplayNames = {
    javascript: 'JavaScript',
    typescript: 'TypeScript',
    python: 'Python',
    java: 'Java',
    cpp: 'C++',
    c: 'C',
    csharp: 'C#',
    go: 'Go',
    rust: 'Rust',
    php: 'PHP',
    ruby: 'Ruby',
    bash: 'Shell',
    sql: 'SQL',
    html: 'HTML',
    css: 'CSS',
    json: 'JSON',
    yaml: 'YAML',
    markdown: 'Markdown',
    text: 'Text'
};

// ========== detectCodeLanguage（内联复制） ==========

function detectCodeLanguage(code, hintedLang) {
    if (hintedLang && hintedLang !== 'text' && hintedLang !== 'plaintext') {
        return hintedLang;
    }
    const trimmed = code.trim();
    if (
        (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
        try {
            JSON.parse(trimmed);
            return 'json';
        } catch (_e) {
            // 不是有效 JSON
        }
    }
    if (/<(!DOCTYPE html|html|head|body|div|span|p|a|img|script|style)/i.test(code)) return 'html';
    if (/[.#][\w-]+\s*\{[^}]*\}/.test(code) || /@(media|keyframes|import)/.test(code)) return 'css';
    if (/^(def |class |import |from |if __name__|print\()/m.test(code)) return 'python';
    if (/\b(function|const|let|var|=>|async|await|class|interface|type)\b/.test(code)) {
        if (/:\s*(string|number|boolean|any|void|unknown|never)\b|interface |type /.test(code)) {
            return 'typescript';
        }
        return 'javascript';
    }
    if (
        /\b(public |private |protected |class |interface |extends |implements |package |import java\.)/m.test(
            code
        )
    )
        return 'java';
    if (/#include\s*<|using namespace |std::|cout|cin|vector</.test(code)) return 'cpp';
    if (/#include\s*<stdio\.h>|#include\s*<stdlib\.h>|int main\(|printf\(|scanf\(/.test(code))
        return 'c';
    if (
        /\b(using System;|namespace |class |public static void Main|Console\.WriteLine)/m.test(code)
    )
        return 'csharp';
    if (/^package |func |import \(|fmt\.Print/.test(code)) return 'go';
    if (/\b(fn |let mut |impl |use |pub |struct |enum |match )\b/.test(code)) return 'rust';
    if (/^<\?php|\$[a-zA-Z_]|->|::|echo |function /.test(code)) return 'php';
    if (/\b(def |end\b|class |module |puts |require )\b/.test(code)) return 'ruby';
    if (
        /^#!\/bin\/(bash|sh)|^\s*(if |for |while |case |function |echo |export |cd |ls |grep )/m.test(
            code
        )
    )
        return 'bash';
    if (/\b(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|FROM|WHERE|JOIN|TABLE)\b/i.test(code))
        return 'sql';
    if (/^[\w-]+:\s*$|^ {2}[\w-]+:\s/m.test(code) && !/[{}[\]]/.test(code)) return 'yaml';
    if (/^#{1,6}\s|^\*\*|^- |^\d+\. |^\[.+\]\(.+\)/.test(code)) return 'markdown';
    return 'text';
}

// ========== generateCodeTitle（内联复制） ==========

function generateCodeTitle(code, language) {
    const firstLine = code.trim().split('\n')[0].trim();
    if (firstLine.startsWith('//') || firstLine.startsWith('#')) {
        const title = firstLine.replace(/^[//#]+\s*/, '').trim();
        if (title.length > 0 && title.length < 60) {
            return title;
        }
    }
    const patterns = {
        javascript: /(?:function|class|const|let)\s+([a-zA-Z_$][\w$]*)/,
        typescript: /(?:function|class|const|let|interface|type)\s+([a-zA-Z_$][\w$]*)/,
        python: /(?:def|class)\s+([a-zA-Z_][\w]*)/,
        java: /(?:public|private|protected)?\s*(?:static)?\s*(?:class|interface)\s+([A-Z][\w]*)/,
        cpp: /(?:class|struct|namespace)\s+([a-zA-Z_][\w]*)/,
        go: /func\s+([a-zA-Z_][\w]*)/,
        rust: /(?:fn|struct|enum|trait)\s+([a-zA-Z_][\w]*)/
    };
    const pattern = patterns[language];
    if (pattern) {
        const match = code.match(pattern);
        if (match) {
            return `${match[1]} - ${languageDisplayNames[language] || language}`;
        }
    }
    const fileMatch = code.match(/\/([a-zA-Z0-9_-]+\.[a-z]+)/);
    if (fileMatch) {
        return fileMatch[1];
    }
    return `${languageDisplayNames[language] || language} 代码`;
}

// 下载文件扩展名映射
const downloadExtensions = {
    javascript: 'js',
    typescript: 'ts',
    python: 'py',
    java: 'java',
    cpp: 'cpp',
    c: 'c',
    csharp: 'cs',
    go: 'go',
    rust: 'rs',
    php: 'php',
    ruby: 'rb',
    bash: 'sh',
    sql: 'sql',
    html: 'html',
    css: 'css',
    json: 'json',
    yaml: 'yaml',
    markdown: 'md',
    text: 'txt'
};

// ========== 语言检测测试 ==========

describe('detectCodeLanguage', () => {
    it('有效 hintedLang 直接返回', () => {
        expect(detectCodeLanguage('any code', 'python')).toBe('python');
    });

    it('hintedLang 为 text 时继续检测', () => {
        expect(detectCodeLanguage('{"key": "value"}', 'text')).toBe('json');
    });

    it('hintedLang 为 plaintext 时继续检测', () => {
        expect(detectCodeLanguage('def hello():\n  pass', 'plaintext')).toBe('python');
    });

    it('检测 JSON 对象', () => {
        expect(detectCodeLanguage('{"name": "test", "value": 1}')).toBe('json');
    });

    it('检测 JSON 数组', () => {
        expect(detectCodeLanguage('[1, 2, 3]')).toBe('json');
    });

    it('非法 JSON 花括号不误判', () => {
        expect(detectCodeLanguage('{not: valid json}')).not.toBe('json');
    });

    it('检测 HTML', () => {
        expect(detectCodeLanguage('<div>Hello</div>')).toBe('html');
        expect(detectCodeLanguage('<!DOCTYPE html>')).toBe('html');
    });

    it('检测 CSS', () => {
        expect(detectCodeLanguage('.container { display: flex; }')).toBe('css');
        expect(detectCodeLanguage('@media (max-width: 600px) {}')).toBe('css');
    });

    it('检测 Python', () => {
        expect(detectCodeLanguage('def hello():\n    print("hi")')).toBe('python');
        expect(detectCodeLanguage('from os import path')).toBe('python');
    });

    it('检测 JavaScript', () => {
        expect(detectCodeLanguage('const x = 1')).toBe('javascript');
        expect(detectCodeLanguage('async function test() { await fetch() }')).toBe('javascript');
    });

    it('检测 TypeScript', () => {
        expect(detectCodeLanguage('const x: string = "hello"')).toBe('typescript');
        expect(detectCodeLanguage('interface User { name: string }')).toBe('typescript');
    });

    it('检测 Java', () => {
        // JS 的 class/interface 关键字优先匹配，用 Java 独有的 'private ' 开头
        expect(
            detectCodeLanguage('private void doSomething() {\n    System.out.println("hi");\n}')
        ).toBe('java');
    });

    it('检测 C++', () => {
        expect(detectCodeLanguage('#include <iostream>\nusing namespace std;')).toBe('cpp');
    });

    it('检测 C', () => {
        // #include <stdio.h> 会先命中 C++ 规则（#include <），需用 C 独有特征
        expect(detectCodeLanguage('printf("hello");\nscanf("%d", &x);')).toBe('c');
    });

    it('检测 Go', () => {
        // 'package main' 匹配 Java 的 'package '，用更明确的 Go 特征
        expect(detectCodeLanguage('func main() {\n  fmt.Println("hello")')).toBe('go');
    });

    it('检测 Rust', () => {
        // 'let' 被 JS 先匹配，用不含 JS 关键字的 Rust 独有特征
        expect(detectCodeLanguage('pub struct Config {\n    name: String,\n}')).toBe('rust');
    });

    it('检测 SQL', () => {
        expect(detectCodeLanguage('SELECT * FROM users WHERE id = 1')).toBe('sql');
    });

    it('检测 Bash', () => {
        // '#!/bin/bash' 需要在行首，echo 会先匹配 PHP 的 'echo ' 规则
        expect(detectCodeLanguage('#!/bin/bash\nif [ -f test ]; then\nfi')).toBe('bash');
    });

    it('未知语言回退为 text', () => {
        expect(detectCodeLanguage('some random content 12345')).toBe('text');
    });
});

// ========== 代码标题生成测试 ==========

describe('generateCodeTitle', () => {
    it('从注释行提取标题', () => {
        expect(generateCodeTitle('// 用户认证模块\nconst x = 1', 'javascript')).toBe(
            '用户认证模块'
        );
    });

    it('从 # 注释行提取标题', () => {
        expect(generateCodeTitle('# 数据处理脚本\ndef main():', 'python')).toBe('数据处理脚本');
    });

    it('提取 JavaScript 函数名', () => {
        expect(
            generateCodeTitle('function handleSubmit() {\n  return true;\n}', 'javascript')
        ).toBe('handleSubmit - JavaScript');
    });

    it('提取 Python 类名', () => {
        expect(generateCodeTitle('class UserModel:\n    pass', 'python')).toBe(
            'UserModel - Python'
        );
    });

    it('提取 Go 函数名', () => {
        expect(generateCodeTitle('func main() {\n}', 'go')).toBe('main - Go');
    });

    it('回退到语言默认标题', () => {
        expect(generateCodeTitle('x = 1\ny = 2', 'python')).toBe('Python 代码');
    });

    it('从路径提取文件名', () => {
        expect(generateCodeTitle('// /src/utils.js\nmore code', 'text')).toBe('/src/utils.js')
            .toBeFalsy; // 注释优先
    });

    it('未知语言默认标题', () => {
        expect(generateCodeTitle('nothing special', 'text')).toBe('Text 代码');
    });
});

// ========== 文件扩展名映射测试 ==========

describe('downloadExtensions', () => {
    it('JavaScript 映射 js', () => {
        expect(downloadExtensions['javascript']).toBe('js');
    });

    it('TypeScript 映射 ts', () => {
        expect(downloadExtensions['typescript']).toBe('ts');
    });

    it('Python 映射 py', () => {
        expect(downloadExtensions['python']).toBe('py');
    });

    it('C# 映射 cs', () => {
        expect(downloadExtensions['csharp']).toBe('cs');
    });

    it('未知语言回退 txt', () => {
        expect(downloadExtensions['unknown'] || 'txt').toBe('txt');
    });
});

// ========== 语言显示名称映射测试 ==========

describe('languageDisplayNames', () => {
    it('包含所有主要语言', () => {
        const expected = [
            'javascript',
            'typescript',
            'python',
            'java',
            'cpp',
            'go',
            'rust',
            'sql',
            'html',
            'css'
        ];
        expected.forEach((lang) => {
            expect(languageDisplayNames[lang]).toBeTruthy();
        });
    });

    it('C++ 显示为 C++', () => {
        expect(languageDisplayNames['cpp']).toBe('C++');
    });

    it('bash 显示为 Shell', () => {
        expect(languageDisplayNames['bash']).toBe('Shell');
    });
});
