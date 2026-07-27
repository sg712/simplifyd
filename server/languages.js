// Language registry: starter-code generation + test-harness codegen per language.
//
// Every harness speaks the same wire protocol back to the judge, one line per
// test, flushed immediately so a crash or timeout still preserves the results
// that already completed:
//
//   __DC__<index>|PASS|FAIL|ERR|<base64 payload>
//
// Payload is the rendered "actual" value for PASS/FAIL, or an error message.
import { execFile } from 'node:child_process';

// ---------- type system ----------
// Problem signatures use these abstract types; each language maps them.
const TYPES = {
  int: {
    js: 'number', py: 'int', java: 'int', javaRet: 'int', cpp: 'int', cppRet: 'int',
    javaZero: '0', cppZero: '0', pyZero: '0', jsZero: '0',
    javaLit: (v) => String(v),
    cppLit: (v) => String(v),
    javaEq: (a, b) => `${a} == ${b}`,
    javaRepr: (a) => `String.valueOf(${a})`,
  },
  bool: {
    js: 'boolean', py: 'bool', java: 'boolean', javaRet: 'boolean', cpp: 'bool', cppRet: 'bool',
    javaZero: 'false', cppZero: 'false', pyZero: 'False', jsZero: 'false',
    javaLit: (v) => String(v),
    cppLit: (v) => String(v),
    javaEq: (a, b) => `${a} == ${b}`,
    javaRepr: (a) => `String.valueOf(${a})`,
  },
  string: {
    js: 'string', py: 'str', java: 'String', javaRet: 'String', cpp: 'string&', cppRet: 'string',
    javaZero: '""', cppZero: '""', pyZero: '""', jsZero: '""',
    javaLit: (v) => JSON.stringify(v),
    cppLit: (v) => JSON.stringify(v),
    javaEq: (a, b) => `${a}.equals(${b})`,
    javaRepr: (a) => `"\\"" + ${a} + "\\""`,
  },
  'int[]': {
    js: 'number[]', py: 'List[int]', java: 'int[]', javaRet: 'int[]',
    cpp: 'vector<int>&', cppRet: 'vector<int>',
    javaZero: 'new int[0]', cppZero: '{}', pyZero: '[]', jsZero: '[]',
    javaLit: (v) => `new int[]{${v.join(',')}}`,
    cppLit: (v) => `{${v.join(',')}}`,
    javaEq: (a, b) => `java.util.Arrays.equals(${a}, ${b})`,
    javaRepr: (a) => `java.util.Arrays.toString(${a})`,
  },
  'int[][]': {
    js: 'number[][]', py: 'List[List[int]]', java: 'int[][]', javaRet: 'int[][]',
    cpp: 'vector<vector<int>>&', cppRet: 'vector<vector<int>>',
    javaZero: 'new int[0][0]', cppZero: '{}', pyZero: '[]', jsZero: '[]',
    javaLit: (v) => `new int[][]{${v.map((r) => `new int[]{${r.join(',')}}`).join(',')}}`,
    cppLit: (v) => `{${v.map((r) => `{${r.join(',')}}`).join(',')}}`,
    javaEq: (a, b) => `java.util.Arrays.deepEquals(${a}, ${b})`,
    javaRepr: (a) => `java.util.Arrays.deepToString(${a})`,
  },
};

const t = (name) => {
  const type = TYPES[name];
  if (!type) throw new Error(`Unknown signature type: ${name}`);
  return type;
};

// ---------- starter-code generation ----------
// Generated from the problem signature so adding a language doesn't mean
// hand-writing 8 more snippets.

function starterJs(p) {
  const { args, ret, params } = p.signature;
  const doc = params
    .map((name, i) => ` * @param {${t(args[i]).js}} ${name}`)
    .concat(` * @return {${t(ret).js}}`)
    .join('\n');
  return `/**\n${doc}\n */\nfunction ${p.functionName}(${params.join(', ')}) {\n  // your code here\n}\n`;
}

function starterPy(p) {
  const { args, ret, params } = p.signature;
  const sig = params.map((name, i) => `${name}: ${t(args[i]).py}`).join(', ');
  // A body of only a comment is a SyntaxError in Python, so seed a placeholder
  // return — the starter has to run before it's edited.
  return `from typing import List\n\nclass Solution:\n    def ${p.functionName}(self, ${sig}) -> ${t(ret).py}:\n        # your code here\n        return ${t(ret).pyZero}\n`;
}

function starterJava(p) {
  const { args, ret, params } = p.signature;
  const sig = params.map((name, i) => `${t(args[i]).java} ${name}`).join(', ');
  return `class Solution {\n    public ${t(ret).javaRet} ${p.functionName}(${sig}) {\n        // your code here\n        return ${t(ret).javaZero};\n    }\n}\n`;
}

function starterCpp(p) {
  const { args, ret, params } = p.signature;
  const sig = params.map((name, i) => `${t(args[i]).cpp} ${name}`).join(', ');
  return `class Solution {\npublic:\n    ${t(ret).cppRet} ${p.functionName}(${sig}) {\n        // your code here\n        return ${t(ret).cppZero};\n    }\n};\n`;
}

// ---------- harness generation ----------

function harnessJs(p, userCode, tests) {
  return `
${userCode}

const __tests = ${JSON.stringify(tests)};
function __eq(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => __eq(v, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => __eq(a[k], b[k]));
  }
  return false;
}
function __emit(i, st, payload) {
  process.stdout.write('__DC__' + i + '|' + st + '|' + Buffer.from(String(payload), 'utf8').toString('base64') + '\\n');
}
for (let i = 0; i < __tests.length; i++) {
  const tc = __tests[i];
  try {
    if (typeof ${p.functionName} !== 'function') {
      throw new Error('Function "${p.functionName}" is not defined — keep the starter function name.');
    }
    const got = ${p.functionName}(...structuredClone(tc.args));
    __emit(i, __eq(got, tc.expected) ? 'PASS' : 'FAIL', JSON.stringify(got === undefined ? null : got));
  } catch (err) {
    __emit(i, 'ERR', (err && err.message) || String(err));
  }
}
`;
}

function harnessPy(p, userCode, tests) {
  return `
import json, sys, copy, base64, traceback

${userCode}

__tests = json.loads(${JSON.stringify(JSON.stringify(tests))})

def __eq(a, b):
    if isinstance(a, bool) != isinstance(b, bool):
        return False
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(__eq(x, y) for x, y in zip(a, b))
    return a == b

def __emit(i, st, payload):
    enc = base64.b64encode(str(payload).encode('utf-8')).decode('ascii')
    sys.stdout.write('__DC__%d|%s|%s\\n' % (i, st, enc))
    sys.stdout.flush()

for __i, __tc in enumerate(__tests):
    try:
        __sol = Solution()
        __got = __sol.${p.functionName}(*copy.deepcopy(__tc['args']))
        __emit(__i, 'PASS' if __eq(__got, __tc['expected']) else 'FAIL', json.dumps(__got))
    except Exception as __e:
        __emit(__i, 'ERR', '%s: %s' % (type(__e).__name__, __e))
`;
}

function harnessJava(p, userCode, tests) {
  const { args, ret, params } = p.signature;
  const blocks = tests
    .map((tc, i) => {
      const decls = params
        .map((name, j) => `      ${t(args[j]).java} ${name} = ${t(args[j]).javaLit(tc.args[j])};`)
        .join('\n');
      const expected = `${t(ret).javaRet} __exp = ${t(ret).javaLit(tc.expected)};`;
      return `    try {
${decls}
      ${expected}
      ${t(ret).javaRet} __got = __sol.${p.functionName}(${params.join(', ')});
      __emit(${i}, ${t(ret).javaEq('__got', '__exp')} ? "PASS" : "FAIL", ${t(ret).javaRepr('__got')});
    } catch (Throwable __t) { __emit(${i}, "ERR", __t.toString()); }`;
    })
    .join('\n');

  return `import java.util.*;

${userCode}

public class Main {
  static void __emit(int i, String st, String payload) {
    String enc = Base64.getEncoder().encodeToString(payload.getBytes(java.nio.charset.StandardCharsets.UTF_8));
    System.out.println("__DC__" + i + "|" + st + "|" + enc);
    System.out.flush();
  }
  public static void main(String[] __args) {
    Solution __sol = new Solution();
${blocks}
  }
}
`;
}

function harnessCpp(p, userCode, tests) {
  const { args, ret, params } = p.signature;
  const blocks = tests
    .map((tc, i) => {
      const decls = params
        .map((name, j) => {
          const type = t(args[j]);
          // strip the reference marker for the local declaration
          const decl = type.cpp.replace(/&$/, '');
          return `      ${decl} ${name} = ${type.cppLit(tc.args[j])};`;
        })
        .join('\n');
      return `  {
    try {
${decls}
      ${t(ret).cppRet} __exp = ${t(ret).cppLit(tc.expected)};
      ${t(ret).cppRet} __got = __sol.${p.functionName}(${params.join(', ')});
      __emit(${i}, (__got == __exp) ? "PASS" : "FAIL", __repr(__got));
    } catch (const std::exception& __e) { __emit(${i}, "ERR", __e.what()); }
      catch (...) { __emit(${i}, "ERR", "unknown runtime error"); }
  }`;
    })
    .join('\n');

  return `#include <vector>
#include <string>
#include <iostream>
#include <sstream>
#include <algorithm>
#include <numeric>
#include <unordered_map>
#include <unordered_set>
#include <map>
#include <set>
#include <queue>
#include <stack>
#include <climits>
#include <cmath>
#include <cstring>
using namespace std;

${userCode}

static string __b64(const string& in) {
  static const char* T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  string out; int val = 0, valb = -6;
  for (unsigned char c : in) {
    val = (val << 8) + c; valb += 8;
    while (valb >= 0) { out.push_back(T[(val >> valb) & 0x3F]); valb -= 6; }
  }
  if (valb > -6) out.push_back(T[((val << 8) >> (valb + 8)) & 0x3F]);
  while (out.size() % 4) out.push_back('=');
  return out;
}
static string __repr(int v) { return to_string(v); }
static string __repr(bool v) { return v ? "true" : "false"; }
static string __repr(const string& v) { return "\\"" + v + "\\""; }
static string __repr(const vector<int>& v) {
  string s = "["; for (size_t i = 0; i < v.size(); i++) { if (i) s += ","; s += to_string(v[i]); } return s + "]";
}
static string __repr(const vector<vector<int>>& v) {
  string s = "["; for (size_t i = 0; i < v.size(); i++) { if (i) s += ","; s += __repr(v[i]); } return s + "]";
}
static void __emit(int i, const char* st, const string& payload) {
  cout << "__DC__" << i << "|" << st << "|" << __b64(payload) << "\\n" << flush;
}

int main() {
  Solution __sol;
${blocks}
  return 0;
}
`;
}

// ---------- registry ----------

export const LANGUAGES = {
  javascript: {
    id: 'javascript',
    label: 'JavaScript',
    cmMode: 'javascript',
    file: 'main.js',
    probe: [process.execPath, ['--version']],
    starter: starterJs,
    harness: harnessJs,
    run: () => [process.execPath, ['--max-old-space-size=192', 'main.js']],
  },
  python: {
    id: 'python',
    label: 'Python 3',
    cmMode: 'python',
    file: 'main.py',
    probe: ['python3', ['--version']],
    starter: starterPy,
    harness: harnessPy,
    run: () => ['python3', ['main.py']],
  },
  java: {
    id: 'java',
    label: 'Java',
    cmMode: 'text/x-java',
    file: 'Main.java',
    probe: ['javac', ['-version']],
    starter: starterJava,
    harness: harnessJava,
    compile: () => ['javac', ['-nowarn', 'Main.java']],
    run: () => ['java', ['-XX:+UseSerialGC', '-Xmx256m', 'Main']],
  },
  cpp: {
    id: 'cpp',
    label: 'C++',
    cmMode: 'text/x-c++src',
    file: 'main.cpp',
    probe: ['g++', ['--version']],
    starter: starterCpp,
    harness: harnessCpp,
    compile: () => ['g++', ['-std=c++17', '-O1', '-o', 'prog', 'main.cpp']],
    run: () => ['./prog', []],
  },
};

// ---------- availability ----------

const availability = new Map();

function probe(lang) {
  return new Promise((resolve) => {
    const [cmd, args] = lang.probe;
    execFile(cmd, args, { timeout: 10000 }, (err) => resolve(!err));
  });
}

export async function detectLanguages() {
  await Promise.all(
    Object.values(LANGUAGES).map(async (lang) => {
      availability.set(lang.id, await probe(lang));
    })
  );
  return availableLanguages();
}

export function isAvailable(id) {
  return availability.get(id) === true;
}

export function availableLanguages() {
  return Object.values(LANGUAGES).map((lang) => ({
    id: lang.id,
    label: lang.label,
    cmMode: lang.cmMode,
    available: isAvailable(lang.id),
  }));
}

export function starterFor(problem, langId) {
  const lang = LANGUAGES[langId];
  if (!lang) return null;
  return lang.starter(problem);
}
