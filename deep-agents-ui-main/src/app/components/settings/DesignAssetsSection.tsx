"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeftRight,
  AudioLines,
  Check,
  ChevronLeft,
  ChevronRight,
  Edit3,
  FileText,
  FolderPlus,
  ImageIcon,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  Video,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { JanCard, CardItem } from "@/components/settings/JanCard";

interface DesignFolder {
  id: string;
  name: string;
  description: string;
  sort_order: number;
}

interface DesignAsset {
  id: string;
  asset_key: string;
  label: string;
  description: string;
  folder_id: string | null;
  media_type: string;
  mime_type: string;
  storage_backend: string;
  public_url: string | null;
  file_path: string | null;
  size_bytes: number | null;
  sort_order: number;
}

function mediaIcon(type: string) {
  if (type === "video") return <Video className="h-4 w-4 text-blue-500" />;
  if (type === "audio") return <AudioLines className="h-4 w-4 text-amber-500" />;
  if (type === "document") return <FileText className="h-4 w-4 text-red-500" />;
  return <ImageIcon className="h-4 w-4 text-violet-500" />;
}

function storageBadge(backend: string) {
  if (backend === "r2") {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-medium text-violet-600 dark:text-violet-400 border border-violet-500/20">
        Cloudflare R2
      </span>
    );
  }
  if (backend === "supabase") {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
        Supabase Storage
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400 border border-amber-500/20">
      Local File
    </span>
  );
}

function formatBytes(bytes: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function assetPreview(asset: DesignAsset) {
  const src = asset.public_url || `/api/design-assets/image?key=${encodeURIComponent(asset.asset_key)}`;
  if (asset.media_type === "image") {
    return <img src={src} alt={asset.label} className="h-full w-full object-contain" />;
  }
  if (asset.media_type === "video") {
    return <video src={src} controls className="h-full w-full object-contain" />;
  }
  if (asset.media_type === "audio") {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center p-4">
        <AudioLines className="mb-2 h-8 w-8 text-amber-500 opacity-60" />
        <audio src={src} controls className="w-full" />
      </div>
    );
  }
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted-foreground">
      <FileText className="h-10 w-10 text-red-500 opacity-50" />
      <span className="text-xs font-medium">PDF Document</span>
      {asset.public_url && (
        <a href={asset.public_url} target="_blank" rel="noreferrer" className="text-[11px] text-primary underline">
          Open Document
        </a>
      )}
    </div>
  );
}

export function DesignAssetsSection() {
  const [folders, setFolders] = useState<DesignFolder[]>([]);
  const [assets, setAssets] = useState<DesignAsset[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);

  // Folder renaming state
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [editingFolderName, setEditingFolderName] = useState("");
  const [renamingFolder, setRenamingFolder] = useState(false);

  // Asset replacement state
  const [replaceTargetKey, setReplaceTargetKey] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const replaceInputRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const folderRes = await fetch("/api/design-folders");
      const folderData = await folderRes.json();
      const nextFolders: DesignFolder[] = folderData.folders ?? [];
      setFolders(nextFolders);

      let activeFolder = nextFolders.find(f => f.id === selectedFolderId);
      if (!activeFolder && nextFolders.length > 0) {
        activeFolder = nextFolders[0];
      }
      setSelectedFolderId(activeFolder?.id ?? null);

      if (activeFolder) {
        const assetRes = await fetch(`/api/design-assets?folder_id=${activeFolder.id}`);
        const assetData = await assetRes.json();
        setAssets(assetData.assets ?? []);
      } else {
        setAssets([]);
      }
    } finally {
      setLoading(false);
    }
  }, [selectedFolderId]);

  useEffect(() => { load(); }, [load]);

  const selectFolder = async (folderId: string) => {
    setSelectedFolderId(folderId);
    setLoading(true);
    try {
      const assetRes = await fetch(`/api/design-assets?folder_id=${folderId}`);
      const assetData = await assetRes.json();
      setAssets(assetData.assets ?? []);
    } finally {
      setLoading(false);
    }
  };

  const createFolder = async () => {
    if (!newFolderName.trim()) return;
    setCreatingFolder(true);
    try {
      const maxOrder = folders.reduce((max, f) => Math.max(max, f.sort_order ?? 0), 0);
      const res = await fetch("/api/design-folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newFolderName.trim(), sort_order: maxOrder + 1 }),
      });
      if (res.ok) {
        const data = await res.json();
        setNewFolderName("");
        if (data?.folder?.id) {
          setSelectedFolderId(data.folder.id);
        }
        await load();
      }
    } finally {
      setCreatingFolder(false);
    }
  };

  const startRenameFolder = (folder: DesignFolder) => {
    setEditingFolderId(folder.id);
    setEditingFolderName(folder.name);
  };

  const saveRenameFolder = async () => {
    if (!editingFolderId || !editingFolderName.trim()) return;
    setRenamingFolder(true);
    try {
      await fetch(`/api/design-folders/${editingFolderId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: editingFolderName.trim() }),
      });
      setEditingFolderId(null);
      await load();
    } finally {
      setRenamingFolder(false);
    }
  };

  const reorderFolder = async (folderId: string, direction: "left" | "right") => {
    const idx = folders.findIndex(f => f.id === folderId);
    if (idx < 0) return;
    const targetIdx = direction === "left" ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= folders.length) return;

    const current = folders[idx];
    const target = folders[targetIdx];

    const currentOrder = current.sort_order ?? idx;
    const targetOrder = target.sort_order ?? targetIdx;
    const newCurrentOrder = currentOrder === targetOrder ? (direction === "left" ? targetOrder - 1 : targetOrder + 1) : targetOrder;

    await Promise.all([
      fetch(`/api/design-folders/${current.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sort_order: newCurrentOrder }),
      }),
      fetch(`/api/design-folders/${target.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sort_order: currentOrder }),
      }),
    ]);
    await load();
  };

  const deleteFolder = async (folderId: string) => {
    if (!confirm("Are you sure you want to delete this folder? Assets in this folder will be unassigned.")) return;
    await fetch(`/api/design-folders/${folderId}`, { method: "DELETE" });
    if (selectedFolderId === folderId) setSelectedFolderId(null);
    await load();
  };

  const uploadSingle = async (file: File, folderId: string, replaceKey?: string) => {
    const mimeType = file.type || "application/octet-stream";
    const mediaType = mimeType.startsWith("video/")
      ? "video"
      : mimeType.startsWith("audio/")
        ? "audio"
        : mimeType === "application/pdf"
          ? "document"
          : "image";

    let publicUrl = "";
    let storageKey = "";
    let storageBackend = "local_legacy";

    // 1. Try direct browser R2 PUT
    try {
      const signRes = await fetch("/api/r2-sign-upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: file.name,
          contentType: mimeType,
          size: file.size,
          category: "brand-assets",
          folderId: folderId,
        }),
      });
      const signData = await signRes.json();

      if (signData?.enabled && signData?.uploadUrl) {
        try {
          const putRes = await fetch(signData.uploadUrl, {
            method: "PUT",
            headers: { "Content-Type": mimeType },
            body: file,
          });
          if (putRes.ok) {
            publicUrl = signData.publicUrl;
            storageKey = signData.key;
            storageBackend = "r2";
          }
        } catch (corsOrNetworkErr) {
          console.warn("[DesignAssets] Direct R2 browser PUT failed, attempting server upload fallback:", corsOrNetworkErr);
        }
      }
    } catch (signErr) {
      console.warn("[DesignAssets] R2 presign skipped or failed:", signErr);
    }

    // 2. If direct PUT failed or wasn't available, try server-side R2 upload
    if (!publicUrl) {
      try {
        const serverR2Form = new FormData();
        serverR2Form.append("file", file);
        const srvRes = await fetch("/api/r2-upload", { method: "POST", body: serverR2Form });
        const srvData = await srvRes.json();
        if (srvData?.enabled && srvData?.publicUrl) {
          publicUrl = srvData.publicUrl;
          storageKey = srvData.key;
          storageBackend = "r2";
        }
      } catch (srvErr) {
        console.warn("[DesignAssets] Server R2 upload failed:", srvErr);
      }
    }

    // 3. Register asset in DB (with Supabase Storage fallback or local file fallback)
    const formData = new FormData();
    if (!publicUrl) formData.append("file", file);
    formData.append("label", file.name.replace(/\.[^.]+$/, ""));
    formData.append("folder_id", folderId);
    formData.append("media_type", mediaType);
    formData.append("mime_type", mimeType);
    formData.append("size_bytes", String(file.size));
    if (replaceKey) formData.append("asset_key", replaceKey);

    if (publicUrl) {
      formData.append("public_url", publicUrl);
      formData.append("storage_key", storageKey);
      formData.append("storage_backend", storageBackend);
    }

    await fetch("/api/design-assets", { method: "POST", body: formData });
  };

  const uploadFiles = async (files: FileList | null) => {
    if (!files?.length || !selectedFolderId) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        await uploadSingle(file, selectedFolderId);
      }
      await load();
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleReplaceFile = async (files: FileList | null) => {
    if (!files?.length || !replaceTargetKey || !selectedFolderId) return;
    setUploading(true);
    try {
      await uploadSingle(files[0], selectedFolderId, replaceTargetKey);
      await load();
    } finally {
      setUploading(false);
      setReplaceTargetKey(null);
      if (replaceInputRef.current) replaceInputRef.current.value = "";
    }
  };

  const moveAsset = async (assetKey: string, targetFolderId: string) => {
    await fetch("/api/design-assets", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ asset_key: assetKey, folder_id: targetFolderId }),
    });
    await load();
  };

  const deleteAsset = async (assetKey: string) => {
    if (!confirm("Are you sure you want to delete this asset?")) return;
    await fetch("/api/design-assets", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ asset_key: assetKey }),
    });
    await load();
  };

  const activeFolder = folders.find(f => f.id === selectedFolderId);

  return (
    <div className="space-y-5">
      <JanCard>
        <CardItem
          align="start"
          className="flex-col gap-4"
          title={
            <span className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <ImageIcon className="h-4 w-4" />
              </span>
              Brand Asset Folders
            </span>
          }
          description="Organize images, videos, audio, and documents into folders. Attach a folder to an agent to make its catalog available."
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={load} className="gap-1.5 text-xs">
                <RefreshCw className="h-3.5 w-3.5" /> Refresh
              </Button>
              <Button
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={!selectedFolderId || uploading}
                className="gap-1.5 text-xs"
              >
                {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                {uploading ? "Uploading…" : "Upload Assets"}
              </Button>
            </div>
          }
        />

        <div className="mt-4 flex flex-col gap-3">
          {/* Create new folder bar */}
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={newFolderName}
              onChange={e => setNewFolderName(e.target.value)}
              placeholder="New folder name (e.g. Core Brand Kit)"
              className="h-9 max-w-xs text-sm"
              onKeyDown={e => { if (e.key === "Enter") createFolder(); }}
            />
            <Button
              size="sm"
              onClick={createFolder}
              disabled={!newFolderName.trim() || creatingFolder}
              className="gap-1.5 text-xs"
            >
              {creatingFolder ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderPlus className="h-3.5 w-3.5" />}
              Create Folder
            </Button>
          </div>

          {/* Folder chips list */}
          <div className="flex flex-wrap items-center gap-2">
            {folders.map((folder, idx) => (
              <div
                key={folder.id}
                className={`group relative flex items-center rounded-lg border transition-all ${
                  selectedFolderId === folder.id
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border bg-background text-muted-foreground hover:bg-muted"
                }`}
              >
                {editingFolderId === folder.id ? (
                  <div className="flex items-center gap-1 p-1">
                    <Input
                      value={editingFolderName}
                      onChange={e => setEditingFolderName(e.target.value)}
                      className="h-7 w-32 px-2 text-xs"
                      autoFocus
                      onKeyDown={e => {
                        if (e.key === "Enter") saveRenameFolder();
                        if (e.key === "Escape") setEditingFolderId(null);
                      }}
                    />
                    <button
                      type="button"
                      onClick={saveRenameFolder}
                      disabled={renamingFolder || !editingFolderName.trim()}
                      className="rounded p-1 text-primary hover:bg-primary/20"
                    >
                      {renamingFolder ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingFolderId(null)}
                      className="rounded p-1 text-muted-foreground hover:bg-muted"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => selectFolder(folder.id)}
                    className="px-3 py-2 text-left text-xs"
                  >
                    <span className="block font-medium">{folder.name}</span>
                    <span className="block text-[10px] opacity-70">
                      {folder.description || "Folder"}
                    </span>
                  </button>
                )}

                {selectedFolderId === folder.id && editingFolderId !== folder.id && (
                  <div className="flex items-center gap-0.5 border-l border-primary/20 pr-1.5 pl-1">
                    <button
                      type="button"
                      title="Move Left"
                      disabled={idx === 0}
                      onClick={e => { e.stopPropagation(); reorderFolder(folder.id, "left"); }}
                      className="rounded p-1 hover:bg-primary/20 disabled:opacity-30"
                    >
                      <ChevronLeft className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      title="Move Right"
                      disabled={idx === folders.length - 1}
                      onClick={e => { e.stopPropagation(); reorderFolder(folder.id, "right"); }}
                      className="rounded p-1 hover:bg-primary/20 disabled:opacity-30"
                    >
                      <ChevronRight className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      title="Rename Folder"
                      onClick={e => { e.stopPropagation(); startRenameFolder(folder); }}
                      className="rounded p-1 hover:bg-primary/20"
                    >
                      <Edit3 className="h-3 w-3" />
                    </button>
                  </div>
                )}
              </div>
            ))}

            {!loading && folders.length === 0 && (
              <p className="text-xs text-muted-foreground">No folders yet. Create one to start organizing brand assets.</p>
            )}
          </div>

          {/* Hidden file pickers */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,video/*,audio/*,application/pdf"
            className="hidden"
            onChange={e => uploadFiles(e.target.files)}
          />
          <input
            ref={replaceInputRef}
            type="file"
            accept="image/*,video/*,audio/*,application/pdf"
            className="hidden"
            onChange={e => handleReplaceFile(e.target.files)}
          />
        </div>
      </JanCard>

      {/* Assets Grid */}
      {selectedFolderId && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {assets.map(asset => (
            <JanCard key={asset.id} className="overflow-hidden flex flex-col justify-between">
              <div>
                <div className="aspect-video bg-muted relative overflow-hidden">
                  {assetPreview(asset)}
                  <div className="absolute top-2 right-2">
                    {storageBadge(asset.storage_backend)}
                  </div>
                </div>
                <div className="space-y-2.5 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold">{asset.label}</p>
                      <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          {mediaIcon(asset.media_type)}
                          <span className="capitalize">{asset.media_type}</span>
                        </span>
                        {asset.size_bytes ? <span>• {formatBytes(asset.size_bytes)}</span> : null}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => deleteAsset(asset.asset_key)}
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                      title="Delete Asset"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>

                  {asset.public_url && (
                    <a
                      href={asset.public_url}
                      target="_blank"
                      rel="noreferrer"
                      className="block truncate text-[11px] text-primary underline-offset-2 hover:underline"
                    >
                      {asset.public_url}
                    </a>
                  )}
                </div>
              </div>

              {/* Card Footer: Move to Folder & Replace Asset */}
              <div className="border-t border-border/60 bg-muted/20 px-4 py-2.5 flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <ArrowLeftRight className="h-3 w-3 text-muted-foreground shrink-0" />
                  <select
                    value={asset.folder_id || ""}
                    onChange={e => moveAsset(asset.asset_key, e.target.value)}
                    className="h-6 rounded border border-border bg-background px-1.5 text-[11px] text-muted-foreground hover:border-primary focus:outline-none max-w-[130px] truncate"
                    title="Move asset to folder"
                  >
                    {folders.map(f => (
                      <option key={f.id} value={f.id}>{f.name}</option>
                    ))}
                  </select>
                </div>

                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setReplaceTargetKey(asset.asset_key);
                    replaceInputRef.current?.click();
                  }}
                  className="h-6 gap-1 px-2 text-[11px]"
                  title="Replace this asset with another file"
                >
                  <RefreshCw className="h-3 w-3" />
                  Replace
                </Button>
              </div>
            </JanCard>
          ))}

          {assets.length === 0 && (
            <JanCard className="md:col-span-2 xl:col-span-3">
              <div className="flex flex-col items-center gap-3 py-10 text-center">
                <Plus className="h-6 w-6 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">This folder is empty.</p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  className="gap-1.5 text-xs"
                >
                  <Upload className="h-3.5 w-3.5" /> Add assets
                </Button>
              </div>
            </JanCard>
          )}
        </div>
      )}

      {selectedFolderId && folders.length > 0 && (
        <div className="flex justify-between items-center pt-2">
          <p className="text-xs text-muted-foreground">
            Folder: <strong className="text-foreground">{activeFolder?.name}</strong> ({assets.length} asset{assets.length === 1 ? "" : "s"})
          </p>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => deleteFolder(selectedFolderId)}
            className="gap-1.5 text-xs text-destructive hover:bg-destructive/10"
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete folder
          </Button>
        </div>
      )}
    </div>
  );
}
