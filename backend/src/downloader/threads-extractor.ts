/**
 * Threads (threads.com / threads.net) post scraping — pure functions, no I/O.
 *
 * yt-dlp has NO Threads extractor (the bundled 2026.03.17 build ships
 * Instagram only), so a Threads URL falls through to the generic extractor and
 * dies with "Unsupported URL". Briefcase therefore reads the post itself.
 *
 * Threads answers a browser User-Agent with an empty JavaScript shell — no
 * Open Graph tags, no media URLs. It server-renders the full post JSON only for
 * CRAWLER user-agents, so the fetch must send THREADS_CRAWLER_USER_AGENT; see
 * DownloaderService.fetchThreadsMedia().
 *
 * The page embeds the target post AND its replies, so every field here is read
 * relative to the target post's own `"code":"<code>"` marker, with a post
 * boundary guard that refuses to cross into a neighbouring post.
 */

/** Threads server-renders the post JSON only for crawlers; a browser UA gets an empty JS shell. */
export const THREADS_CRAWLER_USER_AGENT =
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

/**
 * Error prefixes. Both are greppable and stable: the frontend's ErrorParser maps
 * them to friendly messages, so they must not be reworded without updating
 * frontend-v3/src/app/services/error-parser.ts.
 */
export const THREADS_POST_UNAVAILABLE_PREFIX = 'THREADS_POST_UNAVAILABLE:';
export const THREADS_NO_VIDEO_PREFIX = 'THREADS_NO_VIDEO:';

export interface ThreadsPostRef {
  username: string;
  code: string;
}

export interface ThreadsMedia {
  /** Progressive .mp4 on the Instagram CDN, signed with expiring oh=/oe= params. */
  videoUrl: string;
  title: string;
  uploadDate?: string;
  thumbnailUrl?: string;
}

interface ThreadsVideoVersion {
  type?: number;
  url?: string;
  width?: number;
  height?: number;
}

/**
 * Post shortcodes are 11-ish characters of [A-Za-z0-9_-]. The `{8,24}` bound is
 * load-bearing: the same JSON blob carries locale fields like `"code":"en_US"`,
 * and treating one of those as a post boundary would make a real video read as
 * "no video in this post".
 *
 * The code is CAPTURED because a boundary only counts when it belongs to a
 * DIFFERENT post: Threads serialises the target post more than once per page
 * (observed twice, ~86KB apart), and treating the post's own repeat as a
 * boundary silently dropped its `taken_at` — so the same post yielded an upload
 * date or not depending on which duplicate the fields happened to fall between.
 */
const POST_CODE_FIELD = /"code":"([A-Za-z0-9_-]{8,24})"/g;

const THREADS_POST_URL =
  /^https?:\/\/(?:www\.)?threads\.(?:com|net)\/@([A-Za-z0-9._]+)\/post\/([A-Za-z0-9_-]+)(?:\/media)?\/?(?:[?#].*)?$/i;

/**
 * Parse a Threads post URL. Returns null for anything else, so non-Threads URLs
 * flow through the normal yt-dlp path untouched.
 *
 * Accepts both hosts: threads.net 301-redirects to threads.com, so users paste
 * either.
 */
export function parseThreadsPostUrl(url: string): ThreadsPostRef | null {
  if (typeof url !== 'string') {
    return null;
  }

  const match = url.trim().match(THREADS_POST_URL);
  if (!match) {
    return null;
  }

  return { username: match[1], code: match[2] };
}

/**
 * Extract the target post's video from crawler-fetched Threads HTML.
 *
 * Scoping rule, verified against a real post page (38 `video_versions` fields,
 * 37 of them null): each post object serialises as
 *   ... "caption":{...} ... "code":"<code>", "image_versions2":{...},
 *       "video_versions":<array|null>, ... "taken_at":<unix>, ...
 * so the target post's video is the FIRST `video_versions` after its `code`,
 * and any intervening post-code field means we have walked into the next post.
 */
export function extractThreadsMedia(html: string, code: string): ThreadsMedia {
  const codeField = `"code":"${code}"`;
  const codeIndex = html.indexOf(codeField);
  if (codeIndex < 0) {
    throw new Error(
      `${THREADS_POST_UNAVAILABLE_PREFIX} post ${code} was not present on the Threads page. ` +
        'The post has been deleted, or it is private or age-restricted so Threads does not render it for logged-out visitors.',
    );
  }

  const afterCode = codeIndex + codeField.length;
  const nextPostIndex = findNextPostCodeIndex(html, afterCode, code);

  const versions = readVideoVersions(html, afterCode, nextPostIndex);
  if (!versions) {
    throw new Error(
      `${THREADS_NO_VIDEO_PREFIX} post ${code} contains no video. ` +
        'Threads rendered the post but its media is image-only or text-only, so there is nothing to download.',
    );
  }

  const best = pickBestRendition(versions);
  if (!best || !best.url) {
    throw new Error(
      `${THREADS_NO_VIDEO_PREFIX} post ${code} contains no video. ` +
        'Threads listed video renditions for the post but none of them carried a playable URL.',
    );
  }

  const caption = readCaptionBefore(html, codeIndex, code);
  const ogDescription = readMetaContent(html, 'og:description');
  const title = collapseWhitespace(caption || ogDescription || `Threads post ${code}`);

  const ogImage = readMetaContent(html, 'og:image');

  return {
    videoUrl: decodeHtmlEntities(best.url),
    title,
    uploadDate: readTakenAtDate(html, afterCode, nextPostIndex),
    thumbnailUrl: ogImage ? decodeHtmlEntities(ogImage) : undefined,
  };
}

/**
 * Pick the rendition to download.
 *
 * Threads normally omits width/height entirely and ships three entries (types
 * 101/102/103) that point at the same progressive .mp4, so the dimension
 * comparison is the exception, not the rule. When dimensions are missing the
 * LOWEST type number is the progressive rendition; higher types are alternate
 * encodings that are not always directly downloadable.
 */
function pickBestRendition(versions: ThreadsVideoVersion[]): ThreadsVideoVersion | null {
  const playable = versions.filter(v => typeof v.url === 'string' && v.url.length > 0);
  if (playable.length === 0) {
    return null;
  }

  const sized = playable.filter(
    v => typeof v.width === 'number' && typeof v.height === 'number' && v.width > 0 && v.height > 0,
  );
  if (sized.length > 0) {
    return sized.reduce((best, v) => (v.width! * v.height! > best.width! * best.height! ? v : best));
  }

  const typed = playable.filter(v => typeof v.type === 'number');
  if (typed.length > 0) {
    return typed.reduce((best, v) => (v.type! < best.type! ? v : best));
  }

  return playable[0];
}

/**
 * Read the target post's `video_versions` array, or null when the post has none.
 *
 * Returning null (rather than throwing) for `"video_versions":null` and for a
 * boundary crossing keeps the two "no video" shapes in one place; the caller
 * turns both into the named THREADS_NO_VIDEO error.
 */
function readVideoVersions(
  html: string,
  fromIndex: number,
  nextPostIndex: number,
): ThreadsVideoVersion[] | null {
  const field = '"video_versions":';

  // Every `video_versions` up to the next DIFFERENT post belongs to this post,
  // which Threads serialises more than once per page. Keep scanning past a
  // `null` one: a stub copy of the post must not mask the copy that carries the
  // real renditions.
  for (
    let fieldIndex = html.indexOf(field, fromIndex);
    fieldIndex >= 0 && (nextPostIndex < 0 || fieldIndex < nextPostIndex);
    fieldIndex = html.indexOf(field, fieldIndex + field.length)
  ) {
    const valueStart = fieldIndex + field.length;
    if (html[valueStart] !== '[') {
      continue;
    }

    const raw = readJsonArrayAt(html, valueStart);
    if (raw === null) {
      continue;
    }

    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed as ThreadsVideoVersion[];
      }
    } catch {
      // Malformed rendition list — keep looking at this post's other copies.
    }
  }

  return null;
}

/**
 * The post's caption precedes its `code` in the serialised object, so this scans
 * BACKWARD. The boundary check is what keeps a post whose caption is null from
 * inheriting the previous post's caption: any post-code field between the
 * caption and our code means the caption belongs to that other post.
 */
function readCaptionBefore(html: string, codeIndex: number, ownCode: string): string | null {
  const field = '"caption":{"text":';
  const captionIndex = html.lastIndexOf(field, codeIndex);
  if (captionIndex < 0) {
    return null;
  }

  // A repeat of our OWN code is another serialisation of the same post, so the
  // caption behind it is still ours; only a different post's code is a boundary.
  if (findNextPostCodeIndex(html.slice(captionIndex, codeIndex), 0, ownCode) >= 0) {
    return null;
  }

  return readJsonStringAt(html, captionIndex + field.length);
}

/** `taken_at` is unix seconds; the filename convention wants UTC YYYY-MM-DD. */
function readTakenAtDate(html: string, fromIndex: number, nextPostIndex: number): string | undefined {
  const match = /"taken_at":(\d+)/.exec(html.slice(fromIndex));
  if (!match) {
    return undefined;
  }
  if (nextPostIndex >= 0 && fromIndex + match.index > nextPostIndex) {
    return undefined;
  }

  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return undefined;
  }

  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

/**
 * Index of the next DIFFERENT post's code field at or after fromIndex, or -1.
 *
 * Repeats of ownCode are skipped: Threads serialises the same post several times
 * per page, and its own duplicate is not a post boundary.
 */
function findNextPostCodeIndex(html: string, fromIndex: number, ownCode: string): number {
  POST_CODE_FIELD.lastIndex = fromIndex;
  let match: RegExpExecArray | null;
  while ((match = POST_CODE_FIELD.exec(html)) !== null) {
    if (match[1] !== ownCode) {
      return match.index;
    }
  }
  return -1;
}

function readMetaContent(html: string, property: string): string | null {
  const pattern = new RegExp(
    `<meta[^>]*property=["']${property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*content=["']([^"']*)["']`,
    'i',
  );
  const match = pattern.exec(html);
  return match ? match[1] : null;
}

/**
 * Read a JSON array starting at `start` (which must index its `[`), tracking
 * string literals so a bracket inside a URL or caption cannot end it early.
 * Returns the raw slice, or null if the array is unterminated.
 */
function readJsonArrayAt(html: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < html.length; i++) {
    const ch = html[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '[' || ch === '{') {
      depth++;
    } else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) {
        return html.slice(start, i + 1);
      }
    }
  }

  return null;
}

/** Read the JSON string literal whose opening quote is at `start`. */
function readJsonStringAt(html: string, start: number): string | null {
  if (html[start] !== '"') {
    return null;
  }

  let escaped = false;
  for (let i = start + 1; i < html.length; i++) {
    const ch = html[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      try {
        return JSON.parse(html.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }

  return null;
}

/**
 * Threads serves its meta tags and JSON URLs HTML-escaped (`&amp;` in every CDN
 * query string, `&#064;` in og:title). One pass, so an escaped literal like
 * `&amp;#064;` decodes to `&#064;` instead of `@`.
 */
function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#\d+|#[xX][0-9a-fA-F]+|[A-Za-z]+);/g, (whole, entity: string) => {
    if (entity[0] === '#') {
      const code =
        entity[1] === 'x' || entity[1] === 'X'
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }

    switch (entity.toLowerCase()) {
      case 'amp':
        return '&';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'nbsp':
        return ' ';
      default:
        return whole;
    }
  });
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
