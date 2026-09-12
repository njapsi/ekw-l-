/**
 * Turn a generated structured payload into the editable text body stored on a
 * `ContentAssetVersion`. The `structured` JSON is kept alongside so the UI can
 * render a rich view; the `body` is what the user edits.
 */
import type { ContentAssetTypeKey } from './schemas.js';

export interface RenderedAsset {
  /** A short human title for the asset card. */
  title: string;
  /** Editable plain-text / markdown body. */
  body: string;
  structured: Record<string, unknown>;
}

function list(items: string[]): string {
  return items.map((i) => `- ${i}`).join('\n');
}

export function renderAsset(
  type: ContentAssetTypeKey,
  data: Record<string, unknown>,
): RenderedAsset {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = data as Record<string, any>;
  switch (type) {
    case 'YT_TITLE_ALTERNATIVES':
      return {
        title: 'Title alternatives',
        body: (s.options as string[]).map((o, i) => `${i + 1}. ${o}`).join('\n'),
        structured: data,
      };
    case 'YT_DESCRIPTION':
      return { title: 'YouTube description', body: String(s.body), structured: data };
    case 'YT_CHAPTERS':
      return {
        title: 'YouTube chapters',
        body: (s.chapters as Array<{ timestamp?: string; title: string }>)
          .map((c) => `${c.timestamp ? `${c.timestamp} ` : ''}${c.title}`)
          .join('\n'),
        structured: data,
      };
    case 'SHORTS_IDEA':
      return {
        title: String(s.title),
        body: `Hook: ${s.hook}\n\nBeats:\n${list(s.beats as string[])}${
          (s.onScreenText as string[])?.length
            ? `\n\nOn-screen text:\n${list(s.onScreenText as string[])}`
            : ''
        }`,
        structured: data,
      };
    case 'TIKTOK_IDEA':
      return {
        title: String(s.title),
        body: `Concept: ${s.concept}\n\nHook: ${s.hook}\n\nBeats:\n${list(s.beats as string[])}`,
        structured: data,
      };
    case 'TIKTOK_CAPTION':
      return {
        title: 'TikTok caption',
        body: `${s.caption}${(s.hashtags as string[])?.length ? `\n\n${(s.hashtags as string[]).map((h) => `#${String(h).replace(/^#/, '')}`).join(' ')}` : ''}`,
        structured: data,
      };
    case 'HOOK':
      return {
        title: `Hooks (${s.format})`,
        body: (s.options as string[]).map((o, i) => `${i + 1}. ${o}`).join('\n'),
        structured: data,
      };
    case 'SCRIPT':
      return {
        title: `Script (${s.format})`,
        body: `Hook: ${s.hook}\n\n${s.script}${s.callToAction ? `\n\nCTA: ${s.callToAction}` : ''}`,
        structured: data,
      };
    case 'SOCIAL_POST':
      return {
        title: `Social post (${s.platform})`,
        body: `${s.body}${(s.hashtags as string[])?.length ? `\n\n${(s.hashtags as string[]).map((h) => `#${String(h).replace(/^#/, '')}`).join(' ')}` : ''}`,
        structured: data,
      };
    case 'BLOG_IDEA':
      return {
        title: String(s.workingTitle),
        body: `Angle: ${s.angle}\nTarget reader: ${s.targetReader}\n\nKey points:\n${list(s.keyPoints as string[])}`,
        structured: data,
      };
    case 'SEO_ARTICLE_OUTLINE':
      return {
        title: String(s.workingTitle),
        body:
          `Target query: ${s.targetQuery} (${s.searchIntent})\n\n` +
          (s.sections as Array<{ heading: string; bullets: string[] }>)
            .map((sec) => `## ${sec.heading}\n${list(sec.bullets)}`)
            .join('\n\n') +
          ((s.internalLinkIdeas as string[])?.length
            ? `\n\nInternal link ideas:\n${list(s.internalLinkIdeas as string[])}`
            : ''),
        structured: data,
      };
    case 'FAQ':
      return {
        title: 'FAQ',
        body: (s.items as Array<{ question: string; answer: string }>)
          .map((i) => `Q: ${i.question}\nA: ${i.answer}`)
          .join('\n\n'),
        structured: data,
      };
    case 'NEWSLETTER_IDEA':
      return {
        title: (s.subjectLines as string[])[0] ?? 'Newsletter idea',
        body:
          `Subject lines:\n${(s.subjectLines as string[]).map((l, i) => `${i + 1}. ${l}`).join('\n')}\n\n` +
          `Angle: ${s.angle}\n\nOutline:\n${list(s.outline as string[])}`,
        structured: data,
      };
    default: {
      const _exhaustive: never = type;
      return { title: String(_exhaustive), body: JSON.stringify(data, null, 2), structured: data };
    }
  }
}
