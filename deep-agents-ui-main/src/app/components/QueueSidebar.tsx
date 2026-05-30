"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { X, RefreshCcw } from "lucide-react";

interface FeederArticle {
    id: string;
    title: string;
    source_domain: string;
    created_at: string;
    status: string;
}

export function QueueSidebar({ onClose }: { onClose: () => void }) {
    const [articles, setArticles] = useState<FeederArticle[]>([]);
    const [totalPending, setTotalPending] = useState(0);
    const [batchSize, setBatchSize] = useState(1);
    const [loading, setLoading] = useState(true);

    const fetchQueue = async () => {
        setLoading(true);
        try {
            // 1. Read queue_batch_size from agent_settings (key-value table)
            const { data: settings } = await supabase
                .from("agent_settings")
                .select("value")
                .eq("key", "queue_batch_size")
                .limit(1)
                .single();
            const size = parseInt(settings?.value ?? "1", 10);
            setBatchSize(size);

            // 2. Fetch ONLY the next N articles in FIFO order (oldest first)
            const { data, count } = await supabase
                .from("feeder_articles")
                .select("id,title,source_domain,created_at,status", { count: "exact" })
                .eq("status", "Pending")
                .order("created_at", { ascending: true })  // FIFO
                .limit(size);

            setArticles(data ?? []);

            // 3. Fetch total pending count separately for the header
            const { count: total } = await supabase
                .from("feeder_articles")
                .select("id", { count: "exact", head: true })
                .eq("status", "Pending");
            setTotalPending(total ?? 0);
        } catch (e) {
            console.error("QueueSidebar fetch error:", e);
        }
        setLoading(false);
    };

    useEffect(() => { fetchQueue(); }, []);

    // Auto-refresh whenever agent_settings changes (e.g. batch size updated)
    useEffect(() => {
        const channel = supabase
            .channel("queue-settings-watch")
            .on(
                "postgres_changes",
                { event: "*", schema: "public", table: "agent_settings" },
                () => { fetchQueue(); }
            )
            .subscribe();
        return () => { supabase.removeChannel(channel); };
    }, []);

    return (
        <div className="flex h-full flex-col border-r border-border bg-card">
            <div className="flex h-16 items-center justify-between border-b border-border px-4">
                <div className="flex items-center gap-2">
                    {/* Show "Next N of TOTAL" to make the batch concept clear */}
                    <h2 className="font-semibold">
                        Queue — Next {batchSize}
                    </h2>
                    <span className="text-xs text-muted-foreground">
                        of {totalPending} pending
                    </span>
                    <Button variant="ghost" size="icon" onClick={fetchQueue} className="h-6 w-6">
                        <RefreshCcw className="h-3 w-3" />
                    </Button>
                </div>
                <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8">
                    <X className="h-4 w-4" />
                </Button>
            </div>

            <ScrollArea className="flex-1">
                {loading ? (
                    <div className="p-4 text-center text-sm text-muted-foreground">Loading queue...</div>
                ) : articles.length === 0 ? (
                    <div className="p-4 text-center text-sm text-muted-foreground">Queue is empty.</div>
                ) : (
                    <div className="flex flex-col gap-2 p-4">
                        {articles.map((article, i) => (
                            <div key={article.id} className="rounded-lg border border-border bg-background p-3 text-sm">
                                <div className="flex items-center gap-2 mb-1">
                                    <span className="text-xs font-bold text-muted-foreground w-4">{i + 1}</span>
                                    <span className="line-clamp-2 font-medium">{article.title}</span>
                                </div>
                                <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground pl-6">
                                    <span>{article.source_domain}</span>
                                    <span>{new Date(article.created_at).toLocaleDateString("en-PK", { timeZone: "Asia/Karachi" })}</span>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </ScrollArea>

            {totalPending > batchSize && (
                <div className="border-t px-4 py-2 text-xs text-muted-foreground text-center">
                    +{totalPending - batchSize} more pending · change batch size in Agent Settings
                </div>
            )}
        </div>
    );
}
