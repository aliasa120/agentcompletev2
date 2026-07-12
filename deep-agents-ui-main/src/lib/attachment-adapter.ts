import { AttachmentAdapter, PendingAttachment, CompleteAttachment } from "@assistant-ui/react";

export class LangGraphAttachmentAdapter implements AttachmentAdapter {
  accept = "*";

  async add({ file }: { file: File }): Promise<PendingAttachment> {
    const isImage = file.type.startsWith("image/");
    const isAudio = file.type.startsWith("audio/");
    const isVideo = file.type.startsWith("video/");
    
    return {
      id: crypto.randomUUID(),
      type: isImage ? "image" : isAudio ? "audio" : isVideo ? "video" : "document",
      name: file.name,
      file,
      status: { type: "requires-action", reason: "composer-send" },
    };
  }

  async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
    const file = attachment.file;
    let mimeType = file.type;
    if (!mimeType) {
      const ext = file.name.split(".").pop()?.toLowerCase();
      if (ext === "pdf") mimeType = "application/pdf";
      else if (["mp3", "wav", "ogg", "m4a", "aac"].includes(ext || "")) mimeType = `audio/${ext === "mp3" ? "mpeg" : ext}`;
      else if (["mp4", "webm", "mov", "avi"].includes(ext || "")) mimeType = `video/${ext === "mov" ? "quicktime" : ext}`;
      else mimeType = "application/octet-stream";
    }

    const base64Data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        const base64 = result.split(",")[1];
        resolve(base64);
      };
      reader.onerror = (err) => reject(err);
      reader.readAsDataURL(file);
    });

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
      // If it's a media or large file, do NOT fall back to the giant base64 dataUrl, 
      // as it will exceed request payload limits and crash/hang the chat interface.
      if (isMedia || isLarge) {
        throw new Error(`Failed to upload media file to storage: ${err?.message || err}`);
      }
    }

    const content: any[] = [];
    if (mimeType.startsWith("image/")) {
      content.push({
        type: "image_url",
        image_url: { url: fileUrl }
      });
    } else if (mimeType.startsWith("audio/")) {
      const format = file.name.split(".").pop()?.toLowerCase() || "mp3";
      content.push({
        type: "input_audio",
        input_audio: {
          data: "placeholder",
          format: format === "mp3" ? "mp3" : "wav"
        }
      });
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

  async remove(attachment: PendingAttachment): Promise<void> {}
}
