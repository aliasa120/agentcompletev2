"use client";

import React from "react";
import type { ToolCall, ActionRequest, ReviewConfig } from "@/app/types/types";
import { SearchCard } from "./SearchCard";
import { ThinkCard } from "./ThinkCard";
import { ExtractCard } from "./ExtractCard";
import { ImageSearchCard } from "./ImageSearchCard";
import { GeminiVisionCard } from "./GeminiVisionCard";
import { ImageGenCard } from "./ImageGenCard";
import { PublishCard } from "./PublishCard";
import { DatabaseSaveCard } from "./DatabaseSaveCard";
import { FileWriteCard } from "./FileWriteCard";
import { FileReadCard } from "./FileReadCard";
import { TodoCard } from "./TodoCard";
import { GenericCard } from "./GenericCard";

export interface AgentEventCardProps {
  toolCall: ToolCall;
  uiComponent?: any;
  stream?: any;
  graphId?: string;
  actionRequest?: ActionRequest;
  reviewConfig?: ReviewConfig;
  onResume?: (value: any) => void;
  isLoading?: boolean;
}

/**
 * Dispatcher component that routes each tool call to its specialized animated card.
 * Drop-in replacement for ToolCallBox — identical props interface.
 */
export const AgentEventCard = React.memo<AgentEventCardProps>((props) => {
  const { toolCall, ...rest } = props;

  // Resolve call_tool to its inner target tool call
  let resolvedToolCall = toolCall;
  if (toolCall.name === "call_tool") {
    let args: any = toolCall.args;
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch (e) {
        // ignore
      }
    }
    const toolName = (args?.tool_name || args?.toolName) as string;
    let targetArgs: any = args?.arguments || args?.args || args?.params || {};
    if (typeof targetArgs === "string") {
      try {
        targetArgs = JSON.parse(targetArgs);
      } catch (e) {
        // ignore
      }
    }
    if (toolName) {
      resolvedToolCall = {
        ...toolCall,
        name: toolName,
        args: (targetArgs && typeof targetArgs === "object" ? targetArgs : {}) as Record<string, unknown>,
      };
    }
  }

  // If there's a custom GenUI component from the server, use GenericCard
  // which knows how to render LoadExternalComponent
  if (props.uiComponent) {
    return <GenericCard toolCall={resolvedToolCall} {...rest} />;
  }

  // Tool-specific card routing
  switch (resolvedToolCall.name) {
    case "unified_search":
      return <SearchCard toolCall={resolvedToolCall} />;

    case "think_tool":
      return <ThinkCard toolCall={resolvedToolCall} />;

    case "unified_extract":
      return <ExtractCard toolCall={resolvedToolCall} />;

    case "fetch_images_brave":
      return <ImageSearchCard toolCall={resolvedToolCall} variant="fetch" />;

    case "view_candidate_images":
      return <ImageSearchCard toolCall={resolvedToolCall} variant="score" />;

    case "analyze_images_gemini":
      return <GeminiVisionCard toolCall={resolvedToolCall} />;

    case "create_post_image":
      return <ImageGenCard toolCall={resolvedToolCall} />;

    case "publish_to_wordpress":
      return <PublishCard toolCall={resolvedToolCall} />;

    case "save_posts_to_supabase":
      return <DatabaseSaveCard toolCall={resolvedToolCall} />;

    case "write_file":
    case "edit_file":
      return <FileWriteCard toolCall={resolvedToolCall} />;

    case "write_todos":
      return <TodoCard toolCall={resolvedToolCall} />;

    case "read_file":
      return <FileReadCard toolCall={resolvedToolCall} />;

    // All other tools (get_design_guide, read_skill, get_wordpress_categories, etc.)
    default:
      return <GenericCard toolCall={resolvedToolCall} {...rest} />;
  }
});

AgentEventCard.displayName = "AgentEventCard";
