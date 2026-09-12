import { z } from 'zod';

/**
 * Zod schemas for the TikTok API responses we consume (Display API v2 + Content
 * Posting API). TikTok returns HTTP 200 with an `error` object; `error.code`
 * `"ok"` means success. A shape mismatch → `MalformedApiDataError`.
 */
export const TikTokError = z
  .object({
    code: z.string().default('ok'),
    message: z.string().optional(),
    log_id: z.string().optional(),
  })
  .default({ code: 'ok' });

export const UserInfoResponse = z.object({
  data: z
    .object({
      user: z
        .object({
          open_id: z.string().optional(),
          union_id: z.string().optional(),
          display_name: z.string().optional(),
          avatar_url: z.string().optional(),
          bio_description: z.string().optional(),
          profile_deep_link: z.string().optional(),
          is_verified: z.boolean().optional(),
          username: z.string().optional(),
          follower_count: z.number().optional(),
          following_count: z.number().optional(),
          likes_count: z.number().optional(),
          video_count: z.number().optional(),
        })
        .default({}),
    })
    .default({ user: {} }),
  error: TikTokError,
});
export type UserInfoResponse = z.infer<typeof UserInfoResponse>;

export const VideoListResponse = z.object({
  data: z
    .object({
      videos: z
        .array(
          z.object({
            id: z.string().min(1),
            create_time: z.number().optional(),
            video_description: z.string().optional(),
            title: z.string().optional(),
            duration: z.number().optional(),
            cover_image_url: z.string().optional(),
            share_url: z.string().optional(),
            embed_link: z.string().optional(),
            like_count: z.number().optional(),
            comment_count: z.number().optional(),
            share_count: z.number().optional(),
            view_count: z.number().optional(),
          }),
        )
        .default([]),
      cursor: z.number().optional(),
      has_more: z.boolean().optional(),
    })
    .default({ videos: [] }),
  error: TikTokError,
});
export type VideoListResponse = z.infer<typeof VideoListResponse>;

export const PublishInitResponse = z.object({
  data: z.object({ publish_id: z.string().optional() }).default({}),
  error: TikTokError,
});
export type PublishInitResponse = z.infer<typeof PublishInitResponse>;

export const PublishStatusResponse = z.object({
  data: z
    .object({
      status: z.string().optional(),
      fail_reason: z.string().optional(),
      publicaly_available_post_id: z.array(z.string()).optional(),
      uploaded_bytes: z.number().optional(),
    })
    .default({}),
  error: TikTokError,
});
export type PublishStatusResponse = z.infer<typeof PublishStatusResponse>;

/** Extract hashtags (#tag) from a caption. */
export function extractHashtags(caption: string | undefined): string[] {
  if (!caption) return [];
  const out = new Set<string>();
  for (const m of caption.matchAll(/#([\p{L}\p{N}_]+)/gu)) out.add(m[1]!.toLowerCase());
  return [...out];
}
