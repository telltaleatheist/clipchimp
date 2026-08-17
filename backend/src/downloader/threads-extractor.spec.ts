// Imported explicitly rather than relied on as globals: the backend tsconfig
// pins "types": ["node"], so ts-jest cannot see ambient jest declarations.
import { describe, expect, it } from '@jest/globals';

import { extractThreadsMedia, parseThreadsPostUrl } from './threads-extractor';

/**
 * Synthetic fixtures reproducing the shape of a real crawler-fetched Threads
 * page. Verified against the live page for @bgonthescene/post/DcHJaCZgBSE:
 * the post object serialises its caption BEFORE its code, and its media fields
 * AFTER it —
 *   "caption":{"text":...} ... "code":"<code>","image_versions2":{...},
 *   "video_versions":<array|null>, ... "taken_at":<unix>
 * — and the page carries the target post plus every reply, so a decoy reply's
 * media must never leak into the target's result.
 */

const TARGET_CODE = 'DcHJaCZgBSE';
const DECOY_CODE = 'DcHTPUVjy4a';

const VIDEO_URL =
  'https://scontent-phl2-1.cdninstagram.com/o1/v/t16/f2/m84/AQOeyb.mp4?_nc_cat=108&amp;oh=00_AQHsP&amp;oe=6A843920';
const DECOY_VIDEO_URL = 'https://scontent-phl2-1.cdninstagram.com/o1/v/t16/f2/m84/DECOY.mp4?oh=00_DECOY&amp;oe=6A000000';

function post(options: {
  code: string;
  caption: string;
  videoVersions: string;
  /** Omitted entirely when absent — a duplicate copy of a post can lack it. */
  takenAt?: number;
}): string {
  return (
    `"paid_partnership":null,"audio":null,` +
    `"caption":{"text":"${options.caption}","has_translation":null,"pk":"179150900674","text_translation":null},` +
    `"caption_is_edited":false,"transcription_data":null,"carousel_media":null,` +
    `"code":"${options.code}","image_versions2":{"candidates":[{"url":"https://example.invalid/thumb.jpg"}]},` +
    `"video_versions":${options.videoVersions},` +
    `"like_count":12,` +
    (options.takenAt === undefined ? '' : `"taken_at":${options.takenAt},`) +
    `"user":{"username":"bgonthescene"},`
  );
}

function page(body: string, ogDescription = 'Jake Lang speaking at 180 Church in Detroit today'): string {
  return (
    '<!DOCTYPE html><html><head>' +
    '<meta property="og:site_name" content="Threads" />' +
    `<meta property="og:title" content="Brendan Gutenschwager (&#064;bgonthescene) on Threads" />` +
    `<meta property="og:description" content="${ogDescription}" />` +
    '<meta property="og:image" content="https://scontent-phl2-1.cdninstagram.com/v/t51/thumb.jpg?stp=cmp1&amp;_nc_cat=105" />' +
    '</head><body><script type="application/json">' +
    '{"locale":{"code":"en_US"},"data":{"data":{"edges":[' +
    body +
    ']}}}</script></body></html>'
  );
}

/** Target post first (real video), then a text-only reply. */
const PAGE_TARGET_THEN_REPLY = page(
  post({
    code: TARGET_CODE,
    caption: 'Jake Lang speaking at 180 Church in Detroit today',
    videoVersions: `[{"type":103,"url":"${VIDEO_URL}"},{"type":101,"url":"${VIDEO_URL}"},{"type":102,"url":"${VIDEO_URL}"}]`,
    takenAt: 1786906500,
  }) +
    post({
      code: DECOY_CODE,
      caption: 'A text-only reply',
      videoVersions: 'null',
      takenAt: 1786911392,
    }),
);

/**
 * The decoy case that matters: the target post has NO video and a LATER,
 * different post does. Scoping by "first video_versions after the code" alone
 * would hand back the wrong post's URL.
 */
const PAGE_IMAGE_POST_THEN_VIDEO_POST = page(
  post({
    code: TARGET_CODE,
    caption: 'An image-only post',
    videoVersions: 'null',
    takenAt: 1786906500,
  }) +
    post({
      code: DECOY_CODE,
      caption: 'A different post that does have video',
      videoVersions: `[{"type":101,"url":"${DECOY_VIDEO_URL}"}]`,
      takenAt: 1786911392,
    }),
);

/**
 * Threads serialises the SAME post more than once per page. Observed live on
 * @bgonthescene/post/DcHJaCZgBSE: its code appeared at two offsets ~86KB apart,
 * and the post's `taken_at` sat past the second copy. Treating a post's own
 * repeat as a boundary dropped the upload date non-deterministically — the same
 * post yielded a date or not depending on which duplicate the fields fell
 * between. Only a DIFFERENT post's code is a boundary.
 */
const PAGE_DUPLICATED_POST = page(
  post({
    code: TARGET_CODE,
    caption: 'Jake Lang speaking at 180 Church in Detroit today',
    videoVersions: `[{"type":101,"url":"${VIDEO_URL}"}]`,
  }) +
    post({
      code: TARGET_CODE,
      caption: 'Jake Lang speaking at 180 Church in Detroit today',
      videoVersions: `[{"type":101,"url":"${VIDEO_URL}"}]`,
      takenAt: 1786906500,
    }) +
    post({
      code: DECOY_CODE,
      caption: 'A different post that does have video',
      videoVersions: `[{"type":101,"url":"${DECOY_VIDEO_URL}"}]`,
      takenAt: 1786911392,
    }),
);

/** A stub first copy must not mask the copy carrying the real renditions. */
const PAGE_DUPLICATED_POST_STUB_FIRST = page(
  post({
    code: TARGET_CODE,
    caption: 'Jake Lang speaking at 180 Church in Detroit today',
    videoVersions: 'null',
  }) +
    post({
      code: TARGET_CODE,
      caption: 'Jake Lang speaking at 180 Church in Detroit today',
      videoVersions: `[{"type":101,"url":"${VIDEO_URL}"}]`,
      takenAt: 1786906500,
    }) +
    post({
      code: DECOY_CODE,
      caption: 'A different post that does have video',
      videoVersions: `[{"type":101,"url":"${DECOY_VIDEO_URL}"}]`,
      takenAt: 1786911392,
    }),
);

describe('parseThreadsPostUrl', () => {
  it('parses threads.com and threads.net, with and without www', () => {
    expect(parseThreadsPostUrl(`https://www.threads.com/@bgonthescene/post/${TARGET_CODE}`)).toEqual({
      username: 'bgonthescene',
      code: TARGET_CODE,
    });
    expect(parseThreadsPostUrl(`https://threads.com/@bgonthescene/post/${TARGET_CODE}`)).toEqual({
      username: 'bgonthescene',
      code: TARGET_CODE,
    });
    expect(parseThreadsPostUrl(`https://www.threads.net/@bgonthescene/post/${TARGET_CODE}`)).toEqual({
      username: 'bgonthescene',
      code: TARGET_CODE,
    });
    expect(parseThreadsPostUrl(`http://threads.net/@bgonthescene/post/${TARGET_CODE}`)).toEqual({
      username: 'bgonthescene',
      code: TARGET_CODE,
    });
  });

  it('tolerates the /media suffix, a trailing slash and a query string', () => {
    const expected = { username: 'bgonthescene', code: TARGET_CODE };
    expect(parseThreadsPostUrl(`https://www.threads.com/@bgonthescene/post/${TARGET_CODE}/media`)).toEqual(expected);
    expect(parseThreadsPostUrl(`https://www.threads.com/@bgonthescene/post/${TARGET_CODE}/`)).toEqual(expected);
    expect(
      parseThreadsPostUrl(`https://www.threads.com/@bgonthescene/post/${TARGET_CODE}/media?xmt=AQG0Nx7lLM8`),
    ).toEqual(expected);
    expect(parseThreadsPostUrl(`https://www.threads.com/@bgonthescene/post/${TARGET_CODE}?xmt=AQG0`)).toEqual(expected);
  });

  it('accepts usernames containing dots and underscores', () => {
    expect(parseThreadsPostUrl(`https://www.threads.com/@some.user_name/post/${TARGET_CODE}`)).toEqual({
      username: 'some.user_name',
      code: TARGET_CODE,
    });
  });

  it('returns null for non-Threads URLs so they flow through untouched', () => {
    expect(parseThreadsPostUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(parseThreadsPostUrl('https://www.instagram.com/p/DcHJaCZgBSE/')).toBeNull();
    expect(parseThreadsPostUrl('https://www.threads.com/@bgonthescene')).toBeNull();
    expect(parseThreadsPostUrl('https://www.threads.com/t/DcHJaCZgBSE')).toBeNull();
    expect(parseThreadsPostUrl('https://notthreads.com/@user/post/DcHJaCZgBSE')).toBeNull();
    expect(parseThreadsPostUrl('')).toBeNull();
  });
});

describe('extractThreadsMedia', () => {
  it('extracts the target post\'s video, caption and date', () => {
    const media = extractThreadsMedia(PAGE_TARGET_THEN_REPLY, TARGET_CODE);

    expect(media.videoUrl).toBe(
      'https://scontent-phl2-1.cdninstagram.com/o1/v/t16/f2/m84/AQOeyb.mp4?_nc_cat=108&oh=00_AQHsP&oe=6A843920',
    );
    expect(media.title).toBe('Jake Lang speaking at 180 Church in Detroit today');
    expect(media.uploadDate).toBe('2026-08-16');
  });

  it('decodes HTML entities in the thumbnail URL', () => {
    const media = extractThreadsMedia(PAGE_TARGET_THEN_REPLY, TARGET_CODE);
    expect(media.thumbnailUrl).toBe('https://scontent-phl2-1.cdninstagram.com/v/t51/thumb.jpg?stp=cmp1&_nc_cat=105');
  });

  it('converts taken_at unix seconds to a UTC YYYY-MM-DD date', () => {
    const media = extractThreadsMedia(
      page(
        post({
          code: TARGET_CODE,
          caption: 'dated post',
          videoVersions: `[{"type":101,"url":"${VIDEO_URL}"}]`,
          takenAt: 1735689600, // 2025-01-01T00:00:00Z
        }),
      ),
      TARGET_CODE,
    );
    expect(media.uploadDate).toBe('2025-01-01');
  });

  it('picks the lowest type number when the renditions carry no dimensions', () => {
    const html = page(
      post({
        code: TARGET_CODE,
        caption: 'multi-rendition post',
        videoVersions:
          '[{"type":103,"url":"https://cdn.invalid/103.mp4"},' +
          '{"type":101,"url":"https://cdn.invalid/101.mp4"},' +
          '{"type":102,"url":"https://cdn.invalid/102.mp4"}]',
        takenAt: 1786906500,
      }),
    );
    expect(extractThreadsMedia(html, TARGET_CODE).videoUrl).toBe('https://cdn.invalid/101.mp4');
  });

  it('prefers the largest rendition when dimensions are present', () => {
    const html = page(
      post({
        code: TARGET_CODE,
        caption: 'sized post',
        videoVersions:
          '[{"type":101,"url":"https://cdn.invalid/small.mp4","width":640,"height":360},' +
          '{"type":102,"url":"https://cdn.invalid/large.mp4","width":1276,"height":720}]',
        takenAt: 1786906500,
      }),
    );
    expect(extractThreadsMedia(html, TARGET_CODE).videoUrl).toBe('https://cdn.invalid/large.mp4');
  });

  it('does not leak a later post\'s video across a code boundary', () => {
    expect(() => extractThreadsMedia(PAGE_IMAGE_POST_THEN_VIDEO_POST, TARGET_CODE)).toThrow(/THREADS_NO_VIDEO:/);

    let thrown: Error | null = null;
    try {
      extractThreadsMedia(PAGE_IMAGE_POST_THEN_VIDEO_POST, TARGET_CODE);
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).not.toBeNull();
    expect(thrown!.message).not.toContain('DECOY');

    // ...and the decoy post itself still resolves correctly when it IS the target.
    expect(extractThreadsMedia(PAGE_IMAGE_POST_THEN_VIDEO_POST, DECOY_CODE).videoUrl).toBe(
      'https://scontent-phl2-1.cdninstagram.com/o1/v/t16/f2/m84/DECOY.mp4?oh=00_DECOY&oe=6A000000',
    );
  });

  it('keeps the upload date when Threads serialises the same post twice', () => {
    // Regression: the post's own repeat was treated as a post boundary, so the
    // taken_at sitting past it was discarded and the download silently fell back
    // to the download date for its filename prefix.
    const media = extractThreadsMedia(PAGE_DUPLICATED_POST, TARGET_CODE);
    expect(media.uploadDate).toBe('2026-08-16');
    expect(media.videoUrl).toContain('AQOeyb.mp4');
    expect(media.videoUrl).not.toContain('DECOY');
  });

  it('reads a later copy of the same post when the first copy is a stub', () => {
    const media = extractThreadsMedia(PAGE_DUPLICATED_POST_STUB_FIRST, TARGET_CODE);
    expect(media.videoUrl).toContain('AQOeyb.mp4');
    expect(media.videoUrl).not.toContain('DECOY');
    expect(media.uploadDate).toBe('2026-08-16');
  });

  it('still refuses to cross into a different post when the target is duplicated', () => {
    // The duplicate-tolerant scan must not become a licence to walk forward into
    // the next post: a target with no video anywhere stays a named failure.
    const html = page(
      post({ code: TARGET_CODE, caption: 'stub copy', videoVersions: 'null' }) +
        post({ code: TARGET_CODE, caption: 'second stub copy', videoVersions: 'null', takenAt: 1786906500 }) +
        post({
          code: DECOY_CODE,
          caption: 'a different post with video',
          videoVersions: `[{"type":101,"url":"${DECOY_VIDEO_URL}"}]`,
          takenAt: 1786911392,
        }),
    );
    expect(() => extractThreadsMedia(html, TARGET_CODE)).toThrow(/THREADS_NO_VIDEO:/);
  });

  it('names the cause when the post is not on the page at all', () => {
    expect(() => extractThreadsMedia(PAGE_TARGET_THEN_REPLY, 'ZzZzZzZzZzZ')).toThrow(
      /THREADS_POST_UNAVAILABLE:.*deleted, or it is private or age-restricted/s,
    );
  });

  it('names the cause when the post exists but has no video', () => {
    expect(() => extractThreadsMedia(PAGE_TARGET_THEN_REPLY, DECOY_CODE)).toThrow(
      /THREADS_NO_VIDEO:.*image-only or text-only/s,
    );
  });

  it('does not mistake a locale "code" field for a post boundary', () => {
    // The real page carries {"locale":{"code":"en_US"}} in the same JSON blob;
    // treating it as a post boundary would report a real video as missing.
    const html = page(
      `"caption":{"text":"post with locale noise","has_translation":null},"carousel_media":null,` +
        `"code":"${TARGET_CODE}","locale":{"code":"en_US"},` +
        `"video_versions":[{"type":101,"url":"https://cdn.invalid/ok.mp4"}],"taken_at":1786906500,`,
    );
    expect(extractThreadsMedia(html, TARGET_CODE).videoUrl).toBe('https://cdn.invalid/ok.mp4');
  });

  it('falls back to og:description when the post has no caption of its own', () => {
    const html = page(
      `"caption":null,"carousel_media":null,"code":"${TARGET_CODE}",` +
        `"video_versions":[{"type":101,"url":"https://cdn.invalid/ok.mp4"}],"taken_at":1786906500,`,
      'Description from the meta tag',
    );
    expect(extractThreadsMedia(html, TARGET_CODE).title).toBe('Description from the meta tag');
  });

  it('does not inherit a previous post\'s caption across a code boundary', () => {
    const html =
      '<html><head></head><body><script>' +
      post({
        code: DECOY_CODE,
        caption: 'The previous post caption',
        videoVersions: 'null',
        takenAt: 1786900000,
      }) +
      `"caption":null,"carousel_media":null,"code":"${TARGET_CODE}",` +
      `"video_versions":[{"type":101,"url":"https://cdn.invalid/ok.mp4"}],"taken_at":1786906500,` +
      '</script></body></html>';

    // No og:description on this page either, so the last resort is the code itself.
    expect(extractThreadsMedia(html, TARGET_CODE).title).toBe(`Threads post ${TARGET_CODE}`);
  });
});
