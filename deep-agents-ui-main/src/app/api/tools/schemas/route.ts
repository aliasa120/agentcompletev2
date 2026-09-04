import { NextRequest, NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import path from "path";

const execAsync = promisify(exec);

export const dynamic = "force-dynamic";

// Standard schemas for all built-in tools
const BUILTIN_SCHEMAS: Record<string, any> = {
  create_post_image: {
    name: "create_post_image",
    description: "Create or edit a styled post image using the configured AI image model. Supports text-to-image and editing.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Text prompt for image generation or editing.",
          default: "",
        },
        aspect_ratio: {
          type: "string",
          description: "Aspect ratio for the image.",
          enum: ["1:1", "16:9", "4:3", "3:2", "2:3", "3:4", "9:16"],
          default: "1:1",
        },
        editing_prompt: {
          type: "string",
          description: "Detailed editing instructions when modifying an image.",
          default: "",
        },
        image_url: {
          type: "string",
          description: "URL of the target image to edit (leave empty for text-to-image).",
          default: "",
        },
        headline_text: {
          type: "string",
          description: "Short headline (max 10 words) for filename generation or overlay.",
          default: "",
        },
        reference_image_urls: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of reference image URLs (<20MB each) for brand/style consistency.",
        },
        reference_asset_keys: {
          type: "array",
          items: { type: "string" },
          description: "Optional brand asset keys or labels attached to the current agent.",
        },
      },
      required: [],
    },
  },
  unified_search: {
    name: "unified_search",
    description: "Search the web for news, facts, and live information across configured search engines.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query string.",
        },
        depth: {
          type: "string",
          description: "Search depth level.",
          enum: ["standard", "deep", "fast"],
          default: "standard",
        },
        max_results: {
          type: "integer",
          description: "Maximum number of search results to return.",
          default: 5,
        },
        include_images: {
          type: "boolean",
          description: "Whether to include image results.",
          default: false,
        },
      },
      required: ["query"],
    },
  },
  unified_extract: {
    name: "unified_extract",
    description: "Extract full clean content and metadata from one or multiple URLs.",
    parameters: {
      type: "object",
      properties: {
        urls: {
          type: "array",
          items: { type: "string" },
          description: "List of HTTP/HTTPS URLs to extract.",
        },
        include_markdown: {
          type: "boolean",
          description: "Return parsed markdown instead of raw text.",
          default: true,
        },
      },
      required: ["urls"],
    },
  },
  terminal: {
    name: "terminal",
    description: "Execute OS shell commands with full server workspace access.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The full shell command line to execute.",
        },
        timeout: {
          type: "integer",
          description: "Max seconds to wait before timeout.",
          default: 120,
        },
      },
      required: ["command"],
    },
  },
  upload_to_storage: {
    name: "upload_to_storage",
    description: "Upload a local workspace file to cloud storage (Cloudflare R2, Supabase fallback) and return a public shareable link.",
    parameters: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Path of the local file, normally the relative name used when creating it (e.g. 'report.pdf').",
        },
        category: {
          type: "string",
          enum: ["", "documents", "images", "audio", "video", "workspace"],
          description: "Optional storage folder override. Leave empty to classify from the file extension.",
          default: "",
        },
      },
      required: ["file_path"],
    },
  },
  omni_analyzer: {
    name: "omni_analyzer",
    description: "Analyze selected files, URLs, or brand assets. Supported assets are attached directly to model context; unsupported assets are analyzed by Omni.",
    parameters: {
      type: "object",
      properties: {
        file_sources: {
          type: "array",
          items: { type: "string" },
          description: "URLs, workspace paths, asset keys, or asset labels to inspect.",
        },
        query: {
          type: "string",
          description: "Specific question or analysis request applied to every selected file.",
          default: "Analyze and summarize these files in detail.",
        },
      },
      required: ["file_sources"],
    },
  },
  youtube_transcript: {
    name: "youtube_transcript",
    description: "Extract full structured transcript from a YouTube video URL or ID.",
    parameters: {
      type: "object",
      properties: {
        video_url_or_id: {
          type: "string",
          description: "The YouTube video URL or 11-character video ID.",
        },
      },
      required: ["video_url_or_id"],
    },
  },
  text_to_speech: {
    name: "text_to_speech",
    description: "Generate spoken voice audio from text.",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "The text to speak (plain sentences without markdown).",
        },
        voice_id: {
          type: "string",
          description: "Optional specific voice ID or preset voice name.",
          default: "",
        },
      },
      required: ["text"],
    },
  },
  think_tool: {
    name: "think_tool",
    description: "Internal reasoning scratchpad for deep thinking.",
    parameters: {
      type: "object",
      properties: {
        thought: {
          type: "string",
          description: "Internal reasoning steps and reflection.",
        },
      },
      required: ["thought"],
    },
  },
  add_memory: {
    name: "add_memory",
    description: "Save a new persistent fact to the user's memory profile.",
    parameters: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The fact, preference, or detail to store.",
        },
        target: {
          type: "string",
          enum: ["USER", "MEMORY"],
          default: "USER",
          description: "Target memory scope.",
        },
      },
      required: ["content"],
    },
  },
  save_wordpress_post: {
    name: "save_wordpress_post",
    description: "Fetch live WordPress categories (action='get_categories') and save generated WordPress blog articles with SEO metadata, category, and images to Supabase (action='save').",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["get_categories", "save"],
          default: "save",
          description: "Use 'get_categories' to fetch live categories from WordPress first, or 'save' to save the article.",
        },
        title: { type: "string", description: "Article headline/title.", default: "" },
        content_md: { type: "string", description: "Full markdown content of the article.", default: "" },
        category: { type: "string", description: "WordPress category name or slug (e.g. 'health', 'economy', 'politics').", default: "" },
        slug: { type: "string", description: "URL slug for the post.", default: "" },
        excerpt: { type: "string", description: "Short 1-2 sentence summary.", default: "" },
        focus_keyword: { type: "string", description: "Primary SEO focus keyword.", default: "" },
        meta_description: { type: "string", description: "SEO meta description.", default: "" },
        image_1_url: { type: "string", description: "Featured hero image URL.", default: "" },
        image_2_url: { type: "string", description: "Secondary in-article image URL.", default: "" },
        status: { type: "string", enum: ["draft", "publish"], default: "draft" },
      },
      required: [],
    },
  },
  save_youtube_video: {
    name: "save_youtube_video",
    description: "Save a YouTube video or Shorts draft with SEO tags and custom thumbnail.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "YouTube video title (up to 100 chars)." },
        description: { type: "string", description: "YouTube video description with links & hashtags." },
        video_url: { type: "string", description: "Public URL or local file path of the video." },
        thumbnail_url: { type: "string", description: "Custom 16:9 thumbnail image URL.", default: "" },
        tags: { type: "array", items: { type: "string" }, description: "List of SEO tags/keywords.", default: [] },
        privacy_status: { type: "string", enum: ["public", "unlisted", "private"], default: "public" },
      },
      required: ["title", "description", "video_url"],
    },
  },
  save_instagram_post: {
    name: "save_instagram_post",
    description: "Save an Instagram Reel, Photo, Video, or Carousel post to Posts console.",
    parameters: {
      type: "object",
      properties: {
        caption: { type: "string", description: "Instagram caption with emojis and hashtags." },
        media_url: { type: "string", description: "URL of the image or video to post." },
        media_type: { type: "string", enum: ["reel", "photo", "video", "carousel"], default: "reel" },
        cover_url: { type: "string", description: "Cover thumbnail URL for reels/videos.", default: "" },
      },
      required: ["caption", "media_url"],
    },
  },
  save_facebook_post: {
    name: "save_facebook_post",
    description: "Save a Facebook Page post, photo, or video reel.",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "Post text/caption." },
        media_type: { type: "string", enum: ["text", "photo", "video"], default: "text" },
        media_url: { type: "string", description: "Media image or video URL.", default: "" },
        title: { type: "string", description: "Video or post title.", default: "" },
        link: { type: "string", description: "Link URL to attach.", default: "" },
      },
      required: ["message"],
    },
  },
  save_linkedin_post: {
    name: "save_linkedin_post",
    description: "Save a LinkedIn post, video, photo, or article share to Posts console.",
    parameters: {
      type: "object",
      properties: {
        commentary: { type: "string", description: "Thought leadership post text, insights, and hashtags." },
        media_url: { type: "string", description: "Cloudflare R2 or web URL for video or image.", default: "" },
        media_type: { type: "string", enum: ["text", "photo", "video", "article"], default: "text" },
        title: { type: "string", description: "Article or video title.", default: "" },
        link: { type: "string", description: "External landing page or article URL.", default: "" },
        visibility: { type: "string", enum: ["PUBLIC", "CONNECTIONS"], default: "PUBLIC" },
      },
      required: ["commentary"],
    },
  },
  save_twitter_post: {
    name: "save_twitter_post",
    description: "Save an X (Twitter) post or thread with photos or videos to Posts console.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Tweet content up to 280 characters with hashtags." },
        media_url: { type: "string", description: "Cloudflare R2 or web URL for image or video.", default: "" },
        media_type: { type: "string", enum: ["photo", "video", "none"], default: "none" },
        reply_to_tweet_id: { type: "string", description: "Tweet ID to reply to (optional).", default: "" },
      },
      required: ["text"],
    },
  },
  save_social_bundle: {
    name: "save_social_bundle",
    description: "Save a multi-platform coordinated campaign across YouTube, Instagram, Facebook, and X in one turn.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Campaign bundle title." },
        instagram: { type: "object", description: "Instagram post payload." },
        facebook: { type: "object", description: "Facebook post payload." },
        youtube: { type: "object", description: "YouTube video payload." },
      },
      required: ["title"],
    },
  },
  publish_to_wordpress: {
    name: "publish_to_wordpress",
    description: "Publishes or drafts formatted HTML posts directly to WordPress website.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Post title." },
        content: { type: "string", description: "Post HTML or markdown content." },
        status: { type: "string", enum: ["draft", "publish"], default: "draft" },
      },
      required: ["title", "content"],
    },
  },
  get_wordpress_categories: {
    name: "get_wordpress_categories",
    description: "Fetch live categories and taxonomy from WordPress REST API.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
};

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const toolKey = searchParams.get("tool_key");

  // Try loading dynamic tool schemas from Python backend
  try {
    const rootDir = path.resolve(process.cwd(), "..");
    const pythonScript = `
import json
from research_agent.tools.dynamic_router import get_all_tool_schemas
schemas = get_all_tool_schemas()
print(json.dumps(schemas))
    `.trim();

    const { stdout } = await execAsync(
      `.venv\\Scripts\\python.exe -c "${pythonScript.replace(/"/g, '\\"')}"`,
      { cwd: rootDir, timeout: 5000 }
    );
    const parsed = JSON.parse(stdout.trim());
    if (toolKey) {
      return NextResponse.json({ schema: parsed[toolKey] || BUILTIN_SCHEMAS[toolKey] || null });
    }
    return NextResponse.json({ schemas: { ...BUILTIN_SCHEMAS, ...parsed } });
  } catch (err) {
    // Fallback to pre-defined static schemas
    if (toolKey) {
      return NextResponse.json({ schema: BUILTIN_SCHEMAS[toolKey] || null });
    }
    return NextResponse.json({ schemas: BUILTIN_SCHEMAS });
  }
}
