// Lossless structural diff between the existing OpenAPI document and the merged proposal. Nothing the proposal model cannot express may vanish silently.
// Messages put the kind before the pointer so a property named token or secret never reads like a credential assignment.
const documentation = new Set(['description', 'summary', 'example', 'examples', 'title', 'tags']);
const narrowing = new Set(['enum', 'const', 'format', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minItems', 'maxItems', 'multipleOf']);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const show = value => { const text = JSON.stringify(value); return text.length > 80 ? `${text.slice(0, 77)}...` : text; };
const pointer = path => path.reduce((text, segment) => segment.startsWith('[') ? `${text}${segment}` : text ? `${text}.${segment}` : segment, '');
// A key directly under a properties map is a property name, never an OpenAPI keyword.
const keyword = path => path.length && path.at(-2) !== 'properties' ? path.at(-1) : null;
const parameterKey = p => `[${p?.in}:${p?.name}]`;

export function diffContract(before, after) {
  const breaking = [], nonBreaking = [];
  const added = (value, path) => {
    const key = keyword(path), at = pointer(path);
    if (narrowing.has(key) || key === 'security' || (key === 'required' && Array.isArray(value) && value.length) || (key === 'requestBody' && value?.required)) breaking.push(`制約を追加: ${at}`);
    else nonBreaking.push(`追加: ${at}`);
  };
  const walk = (a, b, path) => {
    const key = keyword(path), at = pointer(path);
    // An absent parameters list is an empty one, so each dropped or added parameter is reported by name.
    if (key === 'parameters' && (Array.isArray(a) || Array.isArray(b))) { a ??= []; b ??= []; }
    if (documentation.has(key)) { if (!same(a, b)) nonBreaking.push(`説明を変更: ${at}`); return; }
    if (same(a, b)) return;
    if (b === undefined) { breaking.push(`削除: ${at}`); return; }
    if (a === undefined) { added(b, path); return; }
    if ((key === 'required' || key === 'enum') && Array.isArray(a) && Array.isArray(b)) {
      const removed = a.filter(v => !b.some(w => same(v, w))), extra = b.filter(v => !a.some(w => same(v, w)));
      if (removed.length) breaking.push(`${key === 'enum' ? 'enum値を削除' : '必須を解除'}: ${at} ${removed.map(show).join(', ')}`);
      if (extra.length) (key === 'enum' ? nonBreaking : breaking).push(`${key === 'enum' ? 'enum値を追加' : '必須に追加'}: ${at} ${extra.map(show).join(', ')}`);
      return;
    }
    if (key === 'security') { breaking.push(`認証要件を変更: ${at}`); return; }
    if (key === 'parameters' && Array.isArray(a) && Array.isArray(b)) {
      for (const p of a) { const q = b.find(x => parameterKey(x) === parameterKey(p)); walk(p, q, [...path, parameterKey(p)]); }
      for (const q of b) if (!a.some(p => parameterKey(p) === parameterKey(q))) (q?.required ? breaking : nonBreaking).push(`${q?.required ? '必須parameterを追加' : '追加'}: ${pointer([...path, parameterKey(q)])}`);
      return;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      for (let index = 0; index < Math.max(a.length, b.length); index++) walk(a[index], b[index], [...path, `[${index}]`]);
      return;
    }
    if (isObject(a) && isObject(b)) {
      for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[name], b[name], [...path, name]);
      return;
    }
    breaking.push(`変更: ${at} ${show(a)} → ${show(b)}`);
  };
  walk(before, after, []);
  return { breaking, nonBreaking };
}
