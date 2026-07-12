import { AttachmentAdapter, PendingAttachment, CompleteAttachment } from "@assistant-ui/react";

export class LangGraphAttachmentAdapter implements AttachmentAdapter {
  accept = "*";
  private urls = new Map<string, { url: string; mimeType: string }>();

  async *add({ file }: { file: File }) {
    const id = crypto.randomUUID();
    const ext = file.name.split(".").pop()?.toLowerCase() || "";
    const isImage = file.type.startsWith("image/") || ["png", "jpg", "jpeg", "webp", "gif", "svg", "bmp"].includes(ext);
    const isAudio = file.type.startsWith("audio/") || ["mp3", "wav", "ogg", "m4a", "aac", "flac", "opus", "amr", "wma", "aiff", "caf"].includes(ext);
    const isVideo = file.type.startsWith("video/") || ["mp4", "webm", "mov", "avi", "mkv", "flv", "wmv", "3gp", "mpeg", "mpg"].includes(ext);
    const type = isImage ? ("image" as const) : isAudio ? ("audio" as const) : isVideo ? ("video" as const) : ("document" as const);

    // 1. Instantly yield a "running" status with progress 0, so the file card appears with a loading spinner immediately!
    yield {
      id,
      type,
      name: file.name,
      file,
      status: { type: "running" as const, reason: "uploading" as const, progress: 0 },
    };

    // 2. Perform the validation and upload in the background
    const MAX_SIZE = 200 * 1024 * 1024; // 200MB
    if (file.size > MAX_SIZE) {
      yield {
        id,
        type,
        name: file.name,
        file,
        status: { type: "incomplete" as const, reason: "error" as const, error: new Error(`File exceeds 200MB limit`) },
      };
      return;
    }

    let mimeType = file.type;
    if (!mimeType || mimeType === "application/octet-stream") {
      if (ext === "pdf") mimeType = "application/pdf";
      else if (["mp3", "wav", "ogg", "m4a", "aac", "flac", "opus", "amr", "wma", "aiff", "caf"].includes(ext)) {
        mimeType = `audio/${ext === "mp3" ? "mpeg" : ext === "m4a" ? "x-m4a" : ext}`;
      } else if (["mp4", "webm", "mov", "avi", "mkv", "flv", "wmv", "3gp", "mpeg", "mpg"].includes(ext)) {
        mimeType = `video/${ext === "mov" ? "quicktime" : ext === "avi" ? "x-msvideo" : ext}`;
      } else if (["png", "jpg", "jpeg", "webp", "gif", "svg", "bmp"].includes(ext)) {
        mimeType = `image/${ext === "jpg" ? "jpeg" : ext}`;
      } else {
        mimeType = "application/octet-stream";
      }
    }

    // Convert file to Base64 in background
    let base64Data: string;
    try {
      base64Data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          const base64 = result.split(",")[1];
          resolve(base64);
        };
        reader.onerror = (err) => reject(err);
        reader.readAsDataURL(file);
      });
    } catch (err: any) {
      yield {
        id,
        type,
        name: file.name,
        file,
        status: { type: "incomplete" as const, reason: "error" as const, error: err },
      };
      return;
    }

    const dataUrl = `data:${mimeType};base64,${base64Data}`;

    // Upload to local workspace so Python agent tools (like ls, glob) can see the file
    // Skip this for media files (images, audio, video) or files larger than 2MB to prevent HTTP 413 Payload Too Large errors
    const isMedia = mimeType.startsWith("image/") || mimeType.startsWith("audio/") || mimeType.startsWith("video/");
    const isLarge = file.size > 2 * 1024 * 1024;
    
    if (!isMedia && !isLarge) {
      try {
        await fetch("/api/upload-workspace", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            filename: file.name,
            base64: base64Data,
          }),
        });
      } catch (err) {
        console.warn("Failed to write uploaded file to local workspace:", err);
      }
    }

    // Upload to Supabase Storage Bucket ('uploads')
    let fileUrl = dataUrl;
    try {
      const { supabase } = await import("@/lib/supabase");
      const fileExt = file.name.split(".").pop();
      const uniqueFilename = `${crypto.randomUUID()}.${fileExt}`;
      const { error: uploadError } = await supabase.storage
        .from("uploads")
        .upload(uniqueFilename, file, {
          cacheControl: "3600",
          upsert: false,
        });

      if (uploadError) {
        console.warn("Supabase Storage upload error:", uploadError);
        throw new Error(uploadError.message);
      } else {
        const { data: { publicUrl } } = supabase.storage
          .from("uploads")
          .getPublicUrl(uniqueFilename);
        fileUrl = publicUrl;
        console.log("Successfully uploaded to Supabase Storage:", fileUrl);
      }
    } catch (err: any) {
      console.warn("Failed to upload file to Supabase Storage:", err);
      if (isMedia || isLarge) {
        yield {
          id,
          type,
          name: file.name,
          file,
          status: { type: "incomplete" as const, reason: "error" as const, error: err },
        };
        return;
      }
    }

    // Save url/mimeType to map so we can look it up during send()
    this.urls.set(id, { url: fileUrl, mimeType });

    // Yield final completed state
    yield {
      id,
      type,
      name: file.name,
      file,
      status: { type: "requires-action" as const, reason: "composer-send" as const },
    };
  }

  async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
    const resolved = this.urls.get(attachment.id);
    const fileUrl = resolved?.url || "";
    const mimeType = resolved?.mimeType || attachment.file.type;
    const file = attachment.file;

    // Cleanup reference
    this.urls.delete(attachment.id);

    const content: any[] = [];
    if (mimeType.startsWith("image/")) {
      content.push({
        type: "image_url",
        image_url: { url: fileUrl }
      });
    } else if (mimeType.startsWith("audio/")) {
      content.push({
        type: "audio",
        audio: fileUrl,
        filename: file.name,
        mimeType
      });
    } else if (mimeType.startsWith("video/")) {
      content.push({
        type: "video",
        video: fileUrl,
        filename: file.name,
        mimeType
      });
    } else {
      content.push({
        type: "file",
        filename: file.name,
        mimeType: mimeType,
        data: fileUrl
      });
    }

    return {
      id: attachment.id,
      type: attachment.type as any,
      name: file.name,
      content,
      status: { type: "complete" },
    };
  }

  async remove(attachment: PendingAttachment): Promise<void> {
    this.urls.delete(attachment.id);
  }
}
