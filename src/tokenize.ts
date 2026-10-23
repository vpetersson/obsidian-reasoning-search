const STOPWORDS = new Set(
  (
    "a an and are as at be but by for from has have he her his i if in into is it its " +
    "me my no not of on or our she so than that the their them then there these they " +
    "this those to was we were what when where which who why will with you your " +
    "about after all also any can could did do does had how just more most only other " +
    "over some such time very would"
  ).split(" "),
);

/** Very light English plural folding, so "outages" matches "outage" and "boxes" matches "box". */
export function stem(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && /(?:s|x|ch|sh)es$/.test(token)) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss") && !token.endsWith("us")) {
    return token.slice(0, -1);
  }
  return token;
}

export function tokenize(text: string): string[] {
  const out: string[] = [];
  const normalized = text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
  for (const match of normalized.matchAll(/[\p{L}\p{N}]+/gu)) {
    const token = match[0];
    if (token.length < 2 && !/\d/.test(token)) continue;
    if (STOPWORDS.has(token)) continue;
    out.push(stem(token));
  }
  return out;
}
