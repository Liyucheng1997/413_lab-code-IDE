// 极简 glob → 正则：支持 **、*、?、{a,b}。路径统一用 / 分隔、相对工作区根目录。
function globToRegex(glob) {
  let re = '';
  let i = 0;
  let inGroup = false;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // "**/" 匹配零或多级目录
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 3;
          continue;
        }
        re += '.*';
        i += 2;
        continue;
      }
      re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      inGroup = true;
      re += '(?:';
    } else if (c === '}' && inGroup) {
      inGroup = false;
      re += ')';
    } else if (c === ',' && inGroup) re += '|';
    else if ('\\^$+.()|[]'.includes(c)) re += '\\' + c;
    else re += c;
    i++;
  }
  return re;
}

// 返回一个判断函数：相对路径（或其任一父目录）命中任一模式即为 true
function compile(patterns) {
  const list = (patterns || [])
    .map((p) => p.trim().replace(/\\/g, '/'))
    .filter(Boolean)
    .map((p) => {
      // 没有斜杠的模式（如 *.js）匹配任意层级
      if (!p.includes('/')) p = '**/' + p;
      return new RegExp('^' + globToRegex(p) + '(?:/.*)?$', 'i');
    });
  if (!list.length) return null;
  return (rel) => list.some((r) => r.test(rel));
}

module.exports = { globToRegex, compile };
