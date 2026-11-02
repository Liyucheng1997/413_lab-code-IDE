// 代码片段 + 关键字补全。所有语言都有片段；没有语言服务器时额外提供关键字补全，
// 配合 Monaco 自带的“基于文档单词”的补全，保证任何语言都有基础补全。
import { lspStatus } from './lsp-client.js';

const S = {
  python: {
    keywords: 'False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case print len range enumerate zip isinstance super self'.split(' '),
    snippets: {
      def: ['def ${1:name}(${2:args}):\n\t${3:pass}', '函数定义'],
      class: ['class ${1:Name}:\n\tdef __init__(self${2:, args}):\n\t\t${3:pass}', '类定义'],
      if: ['if ${1:condition}:\n\t${2:pass}', 'if 语句'],
      ifmain: ["if __name__ == '__main__':\n\t${1:main()}", '主程序入口'],
      for: ['for ${1:item} in ${2:items}:\n\t${3:pass}', 'for 循环'],
      fori: ['for ${1:i} in range(${2:n}):\n\t${3:pass}', 'range 循环'],
      while: ['while ${1:condition}:\n\t${2:pass}', 'while 循环'],
      try: ['try:\n\t${1:pass}\nexcept ${2:Exception} as ${3:e}:\n\t${4:raise}', 'try/except'],
      with: ["with open(${1:'file.txt'}, '${2:r}', encoding='utf-8') as ${3:f}:\n\t${4:data = f.read()}", '打开文件'],
      lambda: ['lambda ${1:x}: ${2:x}', 'lambda 表达式'],
      listcomp: ['[${1:x} for ${1:x} in ${2:items}${3: if ${4:cond}}]', '列表推导式'],
      dataclass: ['from dataclasses import dataclass\n\n@dataclass\nclass ${1:Name}:\n\t${2:field}: ${3:int}', '数据类'],
      async: ['async def ${1:name}(${2}):\n\t${3:pass}', '异步函数'],
    },
  },
  c: {
    keywords: 'auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while bool true false NULL printf scanf malloc free'.split(' '),
    snippets: {
      main: ['#include <stdio.h>\n\nint main(void) {\n\t${1:printf("Hello, World!\\n");}\n\treturn 0;\n}', 'main 函数'],
      inc: ['#include <${1:stdio.h}>', '包含头文件'],
      for: ['for (int ${1:i} = 0; ${1:i} < ${2:n}; ${1:i}++) {\n\t${3}\n}', 'for 循环'],
      while: ['while (${1:condition}) {\n\t${2}\n}', 'while 循环'],
      if: ['if (${1:condition}) {\n\t${2}\n}', 'if 语句'],
      struct: ['typedef struct ${1:Name} {\n\t${2:int field;}\n} ${1:Name};', '结构体'],
      switch: ['switch (${1:expr}) {\n\tcase ${2:0}:\n\t\t${3}\n\t\tbreak;\n\tdefault:\n\t\tbreak;\n}', 'switch'],
      printf: ['printf("${1:%d}\\n", ${2:value});', 'printf'],
    },
  },
  cpp: {
    keywords: 'alignas alignof and asm auto bool break case catch char class const constexpr const_cast continue decltype default delete do double dynamic_cast else enum explicit export extern false float for friend goto if inline int long mutable namespace new noexcept nullptr operator private protected public register reinterpret_cast return short signed sizeof static static_assert static_cast struct switch template this throw true try typedef typeid typename union unsigned using virtual void volatile while std cout cin endl vector string map unordered_map set pair make_pair'.split(' '),
    snippets: {
      main: ['#include <iostream>\n\nint main() {\n\t${1:std::cout << "Hello, World!" << std::endl;}\n\treturn 0;\n}', 'main 函数'],
      inc: ['#include <${1:iostream}>', '包含头文件'],
      for: ['for (int ${1:i} = 0; ${1:i} < ${2:n}; ++${1:i}) {\n\t${3}\n}', 'for 循环'],
      forr: ['for (auto& ${1:item} : ${2:container}) {\n\t${3}\n}', '范围 for'],
      class: ['class ${1:Name} {\npublic:\n\t${1:Name}();\n\t~${1:Name}();\n\nprivate:\n\t${2}\n};', '类定义'],
      cout: ['std::cout << ${1} << std::endl;', '输出'],
      vec: ['std::vector<${1:int}> ${2:v};', 'vector'],
      ns: ['namespace ${1:name} {\n\t${2}\n}', '命名空间'],
      if: ['if (${1:condition}) {\n\t${2}\n}', 'if 语句'],
      try: ['try {\n\t${1}\n} catch (const std::exception& ${2:e}) {\n\t${3}\n}', 'try/catch'],
    },
  },
  java: {
    keywords: 'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while var record true false null String System'.split(' '),
    snippets: {
      main: ['public static void main(String[] args) {\n\t${1}\n}', 'main 方法'],
      class: ['public class ${1:${TM_FILENAME_BASE}} {\n\tpublic static void main(String[] args) {\n\t\t${2:System.out.println("Hello, World!");}\n\t}\n}', '类 + main'],
      sout: ['System.out.println(${1});', '打印'],
      for: ['for (int ${1:i} = 0; ${1:i} < ${2:n}; ${1:i}++) {\n\t${3}\n}', 'for 循环'],
      foreach: ['for (${1:var} ${2:item} : ${3:items}) {\n\t${4}\n}', 'for-each'],
      if: ['if (${1:condition}) {\n\t${2}\n}', 'if 语句'],
      try: ['try {\n\t${1}\n} catch (${2:Exception} ${3:e}) {\n\t${4:e.printStackTrace();}\n}', 'try/catch'],
    },
  },
  go: {
    keywords: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false make len cap append new panic recover fmt'.split(' '),
    snippets: {
      main: ['package main\n\nimport "fmt"\n\nfunc main() {\n\t${1:fmt.Println("Hello, World!")}\n}', 'main 包'],
      func: ['func ${1:name}(${2}) ${3:error} {\n\t${4}\n}', '函数'],
      if: ['if ${1:condition} {\n\t${2}\n}', 'if 语句'],
      iferr: ['if err != nil {\n\treturn ${1:err}\n}', '错误处理'],
      for: ['for ${1:i} := 0; ${1:i} < ${2:n}; ${1:i}++ {\n\t${3}\n}', 'for 循环'],
      forr: ['for ${1:_}, ${2:v} := range ${3:items} {\n\t${4}\n}', 'range 循环'],
      struct: ['type ${1:Name} struct {\n\t${2}\n}', '结构体'],
      pl: ['fmt.Println(${1})', 'Println'],
    },
  },
  rust: {
    keywords: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while Some None Ok Err Vec String Option Result println'.split(' '),
    snippets: {
      main: ['fn main() {\n\t${1:println!("Hello, World!");}\n}', 'main 函数'],
      fn: ['fn ${1:name}(${2}) -> ${3:()} {\n\t${4}\n}', '函数'],
      struct: ['#[derive(Debug)]\nstruct ${1:Name} {\n\t${2}\n}', '结构体'],
      impl: ['impl ${1:Name} {\n\t${2}\n}', 'impl 块'],
      match: ['match ${1:expr} {\n\t${2:_} => ${3},\n}', 'match'],
      for: ['for ${1:item} in ${2:iter} {\n\t${3}\n}', 'for 循环'],
      pl: ['println!("${1:{\\}}", ${2});', 'println!'],
    },
  },
  javascript: {
    snippets: {
      log: ['console.log(${1});', 'console.log'],
      fn: ['function ${1:name}(${2}) {\n\t${3}\n}', '函数'],
      afn: ['const ${1:name} = (${2}) => {\n\t${3}\n};', '箭头函数'],
      for: ['for (let ${1:i} = 0; ${1:i} < ${2:arr}.length; ${1:i}++) {\n\t${3}\n}', 'for 循环'],
      forof: ['for (const ${1:item} of ${2:items}) {\n\t${3}\n}', 'for...of'],
      if: ['if (${1:condition}) {\n\t${2}\n}', 'if 语句'],
      try: ['try {\n\t${1}\n} catch (${2:err}) {\n\t${3:console.error(err);}\n}', 'try/catch'],
      class: ['class ${1:Name} {\n\tconstructor(${2}) {\n\t\t${3}\n\t}\n}', '类'],
      imp: ["import ${2:name} from '${1:module}';", 'import'],
      afetch: ["const res = await fetch(${1:url});\nconst data = await res.json();", 'fetch JSON'],
    },
  },
  html: {
    snippets: {
      '!': ['<!DOCTYPE html>\n<html lang="${1:zh-CN}">\n<head>\n\t<meta charset="UTF-8">\n\t<meta name="viewport" content="width=device-width, initial-scale=1.0">\n\t<title>${2:Document}</title>\n</head>\n<body>\n\t${3}\n</body>\n</html>', 'HTML5 模板'],
      html5: ['<!DOCTYPE html>\n<html lang="${1:zh-CN}">\n<head>\n\t<meta charset="UTF-8">\n\t<meta name="viewport" content="width=device-width, initial-scale=1.0">\n\t<title>${2:Document}</title>\n</head>\n<body>\n\t${3}\n</body>\n</html>', 'HTML5 模板'],
      script: ['<script src="${1}"></script>', 'script'],
      link: ['<link rel="stylesheet" href="${1:style.css}">', '样式表'],
    },
  },
  csharp: {
    keywords: 'abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using var virtual void volatile while async await Console'.split(' '),
    snippets: {
      cw: ['Console.WriteLine(${1});', 'Console.WriteLine'],
      class: ['public class ${1:Name}\n{\n\t${2}\n}', '类'],
      main: ['static void Main(string[] args)\n{\n\t${1}\n}', 'Main'],
      prop: ['public ${1:int} ${2:Name} { get; set; }', '属性'],
    },
  },
  php: {
    keywords: 'abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile extends final finally fn for foreach function global goto if implements include instanceof insteadof interface isset list match namespace new or print private protected public readonly require return static switch throw trait try unset use var while yield'.split(' '),
    snippets: { php: ['<?php\n\n${1}', 'PHP 开始'], fn: ['function ${1:name}(${2}) {\n\t${3}\n}', '函数'], echo: ['echo ${1};', 'echo'] },
  },
  ruby: { keywords: 'BEGIN END alias and begin break case class def defined? do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield puts require attr_accessor'.split(' '), snippets: { def: ['def ${1:name}\n\t${2}\nend', '方法'] } },
  lua: { keywords: 'and break do else elseif end false for function goto if in local nil not or repeat return then true until while print pairs ipairs require'.split(' '), snippets: { fn: ['function ${1:name}(${2})\n\t${3}\nend', '函数'], for: ['for ${1:i} = 1, ${2:n} do\n\t${3}\nend', 'for 循环'] } },
  shell: { keywords: 'if then else elif fi case esac for while until do done in function select time echo read export local return exit source alias cd ls grep sed awk'.split(' '), snippets: { shebang: ['#!/usr/bin/env bash\nset -euo pipefail\n\n${1}', '脚本头'], if: ['if [[ ${1:condition} ]]; then\n\t${2}\nfi', 'if'], for: ['for ${1:i} in ${2:items}; do\n\t${3}\ndone', 'for'] } },
  kotlin: { keywords: 'as break class continue do else false for fun if in interface is null object package return super this throw true try typealias typeof val var when while data sealed override open private public internal println'.split(' '), snippets: { main: ['fun main() {\n\t${1:println("Hello, World!")}\n}', 'main'], fun: ['fun ${1:name}(${2}): ${3:Unit} {\n\t${4}\n}', '函数'] } },
  swift: { keywords: 'associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private protocol public static struct subscript typealias var break case continue default defer do else fallthrough for guard if in repeat return switch where while as catch false is nil rethrows super self Self throw throws true try print'.split(' '), snippets: { func: ['func ${1:name}(${2}) -> ${3:Void} {\n\t${4}\n}', '函数'] } },
  sql: { snippets: { sel: ['SELECT ${1:*}\nFROM ${2:table}\nWHERE ${3:condition};', 'SELECT'], ins: ['INSERT INTO ${1:table} (${2:cols})\nVALUES (${3:vals});', 'INSERT'], upd: ['UPDATE ${1:table}\nSET ${2:col} = ${3:val}\nWHERE ${4:condition};', 'UPDATE'], ct: ['CREATE TABLE ${1:name} (\n\tid INTEGER PRIMARY KEY,\n\t${2}\n);', 'CREATE TABLE'] } },
};
S.typescript = { snippets: { ...S.javascript.snippets, iface: ['interface ${1:Name} {\n\t${2}\n}', '接口'], type: ['type ${1:Name} = ${2};', '类型别名'] } };
S['objective-c'] = S.c;
S.dart = { keywords: 'abstract as assert async await break case catch class const continue default do dynamic else enum export extends false final finally for if implements import in is late library new null required return static super switch this throw true try var void while with yield print'.split(' '), snippets: { main: ['void main() {\n\t${1:print("Hello, World!");}\n}', 'main'] } };

export function registerSnippets(monaco) {
  for (const [lang, def] of Object.entries(S)) {
    monaco.languages.registerCompletionItemProvider(lang, {
      provideCompletionItems(model, position) {
        const word = model.getWordUntilPosition(position);
        // "!" 不是单词字符，单独处理 HTML 模板
        const line = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
        const bang = lang === 'html' && /(^|\s)!$/.test(line);
        const range = bang ? new monaco.Range(position.lineNumber, position.column - 1, position.lineNumber, position.column) : new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
        const suggestions = [];
        for (const [prefix, [body, desc]] of Object.entries(def.snippets || {})) {
          if (bang !== (prefix === '!')) continue;
          suggestions.push({
            label: { label: prefix, description: desc },
            kind: monaco.languages.CompletionItemKind.Snippet,
            insertText: body,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            documentation: { value: '```' + lang + '\n' + body.replace(/\$\{\d+:?([^}]*)\}/g, '$1').replace(/\$\d/g, '') + '\n```' },
            range,
            sortText: '~' + prefix,
          });
        }
        const st = lspStatus(lang);
        if (def.keywords && !(st && st.state === 'ready')) {
          for (const k of def.keywords) suggestions.push({ label: k, kind: monaco.languages.CompletionItemKind.Keyword, insertText: k, range, sortText: '~~' + k });
        }
        return { suggestions };
      },
      triggerCharacters: lang === 'html' ? ['!'] : [],
    });
  }
}
