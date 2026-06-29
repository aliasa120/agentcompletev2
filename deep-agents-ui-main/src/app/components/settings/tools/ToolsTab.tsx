"use client";

import React from "react";
import { ConnectedIntegrationRow, MCPConnection } from "./ConnectedIntegrationRow";
import { BuiltinToolsPanel } from "./BuiltinToolsPanel";

export function ToolsTab({
  connections,
  onRemoveComposio,
  onRemoveManual,
  onReloadAgent,
}: {
  connections: MCPConnection[];
  onRemoveComposio: (slug: string) => void;
  onRemoveManual: (id: string) => void;
  onReloadAgent?: () => void;
}) {
  const activeConns = connections.filter((c) => c.status === "active");

  return (
    <div className="space-y-3">
      {activeConns.length === 0 ? (
        <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
          No tools connected yet.<br />
          <span className="text-xs">
            Go to the <strong>Composio Gateway</strong>, <strong>Manual MCP</strong>, or{" "}
            <strong>Smithery AI</strong> tabs to connect integrations.
          </span>
        </div>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            Click any integration to expand and manage its individual tools. Toggles are saved to the database.
          </p>
          {activeConns.map((conn) => (
            <ConnectedIntegrationRow
              key={conn.id}
              conn={conn}
              onRemove={() =>
                conn.connection_type === "composio"
                  ? onRemoveComposio(conn.toolkit_slug)
                  : onRemoveManual(conn.id)
              }
              onReloadAgent={onReloadAgent}
            />
          ))}
        </>
      )}

      <BuiltinToolsPanel onReloadAgent={onReloadAgent} />
    </div>
  );
}
