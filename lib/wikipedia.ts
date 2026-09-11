import type { TermCard } from './types';

type WikiPage = { pageid: number; title: string; extract?: string };

export const searchWikipedia = async (query: string): Promise<TermCard[]> => {
  if (!query.trim()) return [];
  const url = new URL('https://zh.wikipedia.org/w/api.php');
  url.search = new URLSearchParams({ action: 'query', format: 'json', generator: 'search', gsrsearch: query, gsrlimit: '8', prop: 'extracts', exintro: '1', explaintext: '1', origin: '*' }).toString();
  const response = await fetch(url);
  if (!response.ok) throw new Error('百科搜索暂时不可用');
  const data = await response.json() as { query?: { pages?: Record<string, WikiPage> } };
  return Object.values(data.query?.pages ?? {}).map((page) => ({ id: `wikipedia-${page.pageid}`, title: page.title, domain: '个人词库', kind: '理论', prompt: page.extract?.slice(0, 110) || `「${page.title}」解决了什么问题？`, sources: [{ label: '维基百科', url: `https://zh.wikipedia.org/wiki/${encodeURIComponent(page.title)}` }], origin: 'wikipedia', reviewStatus: 'candidate' }));
};
