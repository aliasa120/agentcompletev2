"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
import { Upload, Trash2, Loader2, ImageIcon, RefreshCw, Plus, X, Check, Image } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface DesignAsset {
  id: string;
  asset_key: string;
  label: string;
  description: string;
  file_path: string;
  sort_order: number;
}

export function DesignAssetsSection() {
  const [assets, setAssets] = useState<DesignAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  // Add new image state
  const [showAdd, setShowAdd] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newFile, setNewFile] = useState<File | null>(null);
  const [addingNew, setAddingNew] = useState(false);

  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const newFileInputRef = useRef<HTMLInputElement | null>(null);

  const fetchAssets = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/design-assets");
      const data = await res.json();
      setAssets(data.assets ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAssets(); }, [fetchAssets]);

  // Replace existing asset image
  const handleReplace = async (assetKey: string, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(assetKey);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("asset_key", assetKey);
      await fetch("/api/design-assets", { method: "POST", body: formData });
      await fetchAssets();
    } finally {
      setUploading(null);
      e.target.value = "";
    }
  };

  // Add brand new image to library
  const handleAddNew = async () => {
    if (!newFile) return;
    setAddingNew(true);
    try {
      const formData = new FormData();
      formData.append("file", newFile);
      formData.append("label", newLabel || newFile.name.replace(/\.[^.]+$/, ""));
      const res = await fetch("/api/design-assets", { method: "POST", body: formData });
      if (res.ok) {
        setShowAdd(false);
        setNewLabel("");
        setNewFile(null);
        await fetchAssets();
      }
    } finally {
      setAddingNew(false);
    }
  };

  // Delete asset
  const handleDelete = async (assetKey: string) => {
    if (confirmDelete !== assetKey) {
      setConfirmDelete(assetKey);
      // Auto-cancel confirm after 3s
      setTimeout(() => setConfirmDelete(null), 3000);
      return;
    }
    setDeleting(assetKey);
    setConfirmDelete(null);
    try {
      await fetch("/api/design-assets", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asset_key: assetKey }),
      });
      setAssets(prev => prev.filter(a => a.asset_key !== assetKey));
    } finally {
      setDeleting(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-12 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" /> Loading brand assets…
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold">Brand Reference Images</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Upload reference images and attach them to any agent, subagent, or image generator provider
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={fetchAssets} className="gap-1.5 text-xs">
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </Button>
          <Button size="sm" onClick={() => setShowAdd(!showAdd)} className="gap-1.5 text-xs">
            <Plus className="h-3.5 w-3.5" /> Add Image
          </Button>
        </div>
      </div>

      {/* Add New Image Panel */}
      {showAdd && (
        <div className="rounded-xl border-2 border-dashed border-primary/30 bg-primary/5 p-5 space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-primary">Add New Reference Image</p>
            <button onClick={() => { setShowAdd(false); setNewLabel(""); setNewFile(null); }}
              className="text-muted-foreground hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* File picker */}
          <div
            onClick={() => newFileInputRef.current?.click()}
            className={`rounded-lg border-2 border-dashed p-8 text-center cursor-pointer transition-all
              ${newFile ? "border-primary/50 bg-primary/5" : "border-border hover:border-primary/40 hover:bg-muted/30"}`}
          >
            <input
              type="file"
              ref={newFileInputRef}
              accept="image/*"
              className="hidden"
              onChange={e => {
                const f = e.target.files?.[0];
                if (f) {
                  setNewFile(f);
                  if (!newLabel) setNewLabel(f.name.replace(/\.[^.]+$/, ""));
                }
              }}
            />
            {newFile ? (
              <div className="flex flex-col items-center gap-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={URL.createObjectURL(newFile)}
                  alt="Preview"
                  className="max-h-40 max-w-full rounded-lg object-contain"
                />
                <p className="text-xs text-muted-foreground">{newFile.name} — click to change</p>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2 text-muted-foreground">
                <Image className="h-8 w-8 opacity-30" />
                <p className="text-sm">Click to select an image</p>
                <p className="text-xs">PNG, JPG, WEBP supported</p>
              </div>
            )}
          </div>

          {/* Label */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Image Label</label>
            <Input
              value={newLabel}
              onChange={e => setNewLabel(e.target.value)}
              placeholder="e.g. Brand Style Guide, Dark Theme Reference..."
              className="h-9 text-sm"
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => { setShowAdd(false); setNewLabel(""); setNewFile(null); }}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleAddNew} disabled={!newFile || addingNew} className="gap-1.5">
              {addingNew ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              {addingNew ? "Uploading…" : "Add to Library"}
            </Button>
          </div>
        </div>
      )}

      {/* Asset Gallery */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {assets.map(asset => (
          <div key={asset.id} className="rounded-xl border bg-card shadow-sm overflow-hidden group">
            {/* Preview */}
            <div className="relative aspect-video bg-muted flex items-center justify-center overflow-hidden">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/design-assets/image?key=${asset.asset_key}&t=${Date.now()}`}
                alt={asset.label}
                className="w-full h-full object-contain"
                onError={e => {
                  (e.target as HTMLImageElement).style.display = "none";
                  (e.target as HTMLImageElement).nextElementSibling?.classList.remove("hidden");
                }}
              />
              <div className="hidden absolute inset-0 flex flex-col items-center justify-center text-muted-foreground">
                <ImageIcon className="h-10 w-10 mb-2 opacity-30" />
                <p className="text-xs">No image uploaded</p>
              </div>

              {/* Replace overlay on hover */}
              <div
                className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity
                  flex items-center justify-center cursor-pointer"
                onClick={() => fileInputRefs.current[asset.asset_key]?.click()}
              >
                <div className="flex flex-col items-center gap-1 text-white">
                  <Upload className="h-6 w-6" />
                  <span className="text-xs font-medium">Replace Image</span>
                </div>
              </div>
            </div>

            {/* Info & Actions */}
            <div className="p-3">
              <p className="font-semibold text-sm truncate">{asset.label}</p>
              <p className="text-[10px] font-mono text-muted-foreground/60 truncate mt-0.5">{asset.file_path}</p>

              <div className="flex gap-2 mt-3">
                <input
                  type="file"
                  ref={el => { fileInputRefs.current[asset.asset_key] = el; }}
                  accept="image/*"
                  className="hidden"
                  onChange={e => handleReplace(asset.asset_key, e)}
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => fileInputRefs.current[asset.asset_key]?.click()}
                  disabled={uploading === asset.asset_key}
                  className="flex-1 gap-1.5 text-xs h-7"
                >
                  {uploading === asset.asset_key
                    ? <Loader2 className="h-3 w-3 animate-spin" />
                    : <Upload className="h-3 w-3" />
                  }
                  {uploading === asset.asset_key ? "Uploading…" : "Replace"}
                </Button>
                <Button
                  size="sm"
                  variant={confirmDelete === asset.asset_key ? "destructive" : "ghost"}
                  onClick={() => handleDelete(asset.asset_key)}
                  disabled={deleting === asset.asset_key}
                  className="h-7 px-2 text-xs"
                >
                  {deleting === asset.asset_key
                    ? <Loader2 className="h-3 w-3 animate-spin" />
                    : confirmDelete === asset.asset_key
                      ? <span>Delete?</span>
                      : <Trash2 className="h-3 w-3" />
                  }
                </Button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {assets.length === 0 && !showAdd && (
        <div className="rounded-xl border border-dashed p-12 text-center">
          <ImageIcon className="h-8 w-8 text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground mb-1">No reference images yet</p>
          <p className="text-xs text-muted-foreground mb-4">
            Upload images to use as style references for agents and image generators
          </p>
          <Button size="sm" variant="outline" onClick={() => setShowAdd(true)} className="gap-1.5">
            <Plus className="h-3.5 w-3.5" /> Add First Image
          </Button>
        </div>
      )}

      {/* How it works */}
      <div className="rounded-lg bg-muted/30 border p-4 text-xs text-muted-foreground space-y-2">
        <p className="font-medium text-foreground">How reference images work</p>
        <ul className="space-y-1 list-disc list-inside">
          <li>Upload any brand or style reference images here (unlimited)</li>
          <li>Go to <strong>Main Agents</strong> or <strong>Subagents</strong> → open any agent → attach images in the <strong>Reference Images</strong> section</li>
          <li>Go to <strong>Providers</strong> → Image Generation section → attach images to any image provider</li>
          <li>The agent (vision model) sees the attached images directly — no separate analyzer tool needed</li>
          <li>Your system prompt controls when and how the images are used</li>
        </ul>
      </div>
    </div>
  );
}
