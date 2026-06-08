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

  // If there's a custom GenUI component from the server, use GenericCard
  // which knows how to render LoadExternalComponent
  if (props.uiComponent) {
    return <GenericCard toolCall={toolCall} {...rest} />;
  }

  // Tool-specific card routing
  switch (toolCall.name) {
    case "unified_search":
      return <SearchCard toolCall={toolCall} />;

    case "think_tool":
      return <ThinkCard toolCall={toolCall} />;

    case "unified_extract":
      return <ExtractCard toolCall={toolCall} />;

    case "fetch_images_brave":
      return <ImageSearchCard toolCall={toolCall} variant="fetch" />;

    case "view_candidate_images":
      return <ImageSearchCard toolCall={toolCall} variant="score" />;

    case "analyze_images_gemini":
      return <GeminiVisionCard toolCall={toolCall} />;

    case "create_post_image":
      return <ImageGenCard toolCall={toolCall} />;

    case "publish_to_wordpress":
      return <PublishCard toolCall={toolCall} />;

    case "save_posts_to_supabase":
      return <DatabaseSaveCard toolCall={toolCall} />;

    case "write_file":
    case "edit_file":
      return <FileWriteCard toolCall={toolCall} />;

    case "write_todos":
      return <TodoCard toolCall={toolCall} />;

    case "read_file":
      return <FileReadCard toolCall={toolCall} />;

    // All other tools (get_design_guide, read_skill, get_wordpress_categories, etc.)
    default:
      return <GenericCard toolCall={toolCall} {...rest} />;
  }
});

AgentEventCard.displayName = "AgentEventCard";
