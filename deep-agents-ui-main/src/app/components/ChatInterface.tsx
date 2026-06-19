"use client";

import React, {
  useState,
  useRef,
  useCallback,
  useMemo,
  Fragment,
} from "react";
import ClaudeChatInput, { AttachedFile, PastedContent, ClaudeChatInputHandle } from "@/components/ui/claude-style-chat-input";
import { Button } from "@/components/ui/button";
import {
  Square,
  ArrowUp,
  CheckCircle,
  Clock,
  Circle,
  FileIcon,
  SquarePen,
  Database,
  LayoutGrid,
  MessagesSquare,
} from "lucide-react";
import { ChatMessage } from "@/app/components/ChatMessage";
import type {
  TodoItem,
  ToolCall,
  ActionRequest,
  ReviewConfig,
} from "@/app/types/types";
import { Assistant, Message } from "@langchain/langgraph-sdk";
import { extractStringFromMessageContent } from "@/app/utils/utils";
import { useChatContext } from "@/providers/ChatProvider";
import { cn } from "@/lib/utils";
import { useStickToBottom } from "use-stick-to-bottom";
import { FilesPopover } from "@/app/components/TasksFilesSidebar";

interface ChatInterfaceProps {
  assistant: Assistant | null;
  onStartAgent?: () => void;
}

const getStatusIcon = (status: TodoItem["status"], className?: string) => {
  switch (status) {
    case "completed":
      return (
        <CheckCircle
          size={16}
          className={cn("text-emerald-500", className)}
        />
      );
    case "in_progress":
      return (
        <Clock
          size={16}
          className={cn("text-primary", className)}
        />
      );
    default:
      return (
        <Circle
          size={16}
          className={cn("text-muted-foreground/60", className)}
        />
      );
  }
};

export const ChatInterface = React.memo<ChatInterfaceProps>(({ assistant, onStartAgent }) => {
  const [metaOpen, setMetaOpen] = useState<"tasks" | "files" | null>(null);
  const tasksContainerRef = useRef<HTMLDivElement | null>(null);
  const chatInputRef = useRef<ClaudeChatInputHandle>(null);

  const { scrollRef, contentRef } = useStickToBottom();

  const {
    stream,
    messages,
    todos,
    files,
    ui,
    setFiles,
    isLoading,
    isThreadLoading,
    interrupt,
    sendMessage,
    stopStream,
    resumeInterrupt,
  } = useChatContext();

  const submitDisabled = isLoading || !assistant;

  const handleSendMessage = useCallback(
    async (data: {
      message: string;
      files: AttachedFile[];
      pastedContent: PastedContent[];
      model: string;
      isThinkingEnabled: boolean;
    }) => {
      // 1. Process files client-side and upload them to the agent state
      const fileContents: Record<string, string> = {};
      const contentParts: any[] = [];

      // Add main message text if it exists
      if (data.message.trim()) {
        contentParts.push({ type: "text", text: data.message });
      }

      for (const f of data.files) {
        try {
          let mimeType = f.file.type;
          if (!mimeType) {
            // Guess mime type from extension
            const ext = f.file.name.split(".").pop()?.toLowerCase();
            if (ext === "pdf") mimeType = "application/pdf";
            else if (["mp3", "wav", "ogg", "m4a", "aac"].includes(ext || "")) mimeType = `audio/${ext === "mp3" ? "mpeg" : ext}`;
            else if (["mp4", "webm", "mov", "avi"].includes(ext || "")) mimeType = `video/${ext === "mov" ? "quicktime" : ext}`;
            else mimeType = "application/octet-stream";
          }

          const isText =
            mimeType.startsWith("text/") ||
            f.file.name.endsWith(".txt") ||
            f.file.name.endsWith(".md") ||
            f.file.name.endsWith(".json") ||
            f.file.name.endsWith(".js") ||
            f.file.name.endsWith(".ts") ||
            f.file.name.endsWith(".tsx");

          if (isText) {
            const text = await f.file.text();
            fileContents[f.file.name] = text;
            contentParts.push({
              type: "text",
              text: `\n\n[Attached text file: ${f.file.name}]\n${text}`
            });
          } else {
            // Read binary file as base64
            const base64Data = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => {
                const result = reader.result as string;
                const base64 = result.split(",")[1];
                resolve(base64);
              };
              reader.onerror = (err) => reject(err);
              reader.readAsDataURL(f.file);
            });

            const dataUrl = `data:${mimeType};base64,${base64Data}`;
            fileContents[f.file.name] = dataUrl;

            // Attach block based on file MIME type
            if (mimeType.startsWith("image/")) {
              contentParts.push({
                type: "image_url",
                image_url: {
                  url: dataUrl
                }
              });
            } else if (mimeType.startsWith("audio/")) {
              const format = f.file.name.split(".").pop()?.toLowerCase() || "mp3";
              // Attach both input_audio (for OpenAI/MiMo) and image_url (for Gemini compatible layer)
              contentParts.push({
                type: "input_audio",
                input_audio: {
                  data: base64Data,
                  format: format === "mp3" ? "mp3" : "wav"
                }
              });
              contentParts.push({
                type: "image_url",
                image_url: {
                  url: dataUrl
                }
              });
            } else if (mimeType.startsWith("video/")) {
              // Attach both video_url (for MiMo) and image_url (for Gemini compatible layer)
              contentParts.push({
                type: "video_url",
                video_url: {
                  url: dataUrl
                },
                fps: 2,
                media_resolution: "default"
              });
              contentParts.push({
                type: "image_url",
                image_url: {
                  url: dataUrl
                }
              });
            } else {
              // For PDF and other documents, attach as image_url block containing dataURI
              contentParts.push({
                type: "image_url",
                image_url: {
                  url: dataUrl
                }
              });
            }
          }
        } catch (err) {
          console.error("Failed to read file:", f.file.name, err);
        }
      }

      for (const p of data.pastedContent) {
        fileContents[`pasted_text_${p.id}.txt`] = p.content;
        contentParts.push({
          type: "text",
          text: `\n\n[Pasted content]\n${p.content}`
        });
      }

      if (Object.keys(fileContents).length > 0) {
        await setFiles({ ...files, ...fileContents });
      }

      // 2. Send the message
      if (contentParts.length > 0) {
        if (contentParts.length === 1 && contentParts[0].type === "text") {
          sendMessage(data.message);
        } else {
          sendMessage(contentParts);
        }
      }
    },
    [files, sendMessage, setFiles]
  );

  // TODO: can we make this part of the hook?
  const processedMessages = useMemo(() => {
    /*
     1. Loop through all messages
     2. For each AI message, add the AI message, and any tool calls to the messageMap
     3. For each tool message, find the corresponding tool call in the messageMap and update the status and output
    */
    const messageMap = new Map<
      string,
      { message: Message; toolCalls: ToolCall[] }
    >();
    messages.forEach((message: Message) => {
      if (message.type === "ai") {
        const toolCallsInMessage: Array<{
          id?: string;
          function?: { name?: string; arguments?: unknown };
          name?: string;
          type?: string;
          args?: unknown;
          input?: unknown;
        }> = [];
        if (
          message.additional_kwargs?.tool_calls &&
          Array.isArray(message.additional_kwargs.tool_calls)
        ) {
          toolCallsInMessage.push(...message.additional_kwargs.tool_calls);
        } else if (message.tool_calls && Array.isArray(message.tool_calls)) {
          toolCallsInMessage.push(
            ...message.tool_calls.filter(
              (toolCall: { name?: string }) => toolCall.name !== ""
            )
          );
        } else if (Array.isArray(message.content)) {
          const toolUseBlocks = message.content.filter(
            (block: { type?: string }) => block.type === "tool_use"
          );
          toolCallsInMessage.push(...toolUseBlocks);
        }
        const toolCallsWithStatus = toolCallsInMessage.map(
          (toolCall: {
            id?: string;
            function?: { name?: string; arguments?: unknown };
            name?: string;
            type?: string;
            args?: unknown;
            input?: unknown;
          }) => {
            const name =
              toolCall.function?.name ||
              toolCall.name ||
              toolCall.type ||
              "unknown";
            const args =
              toolCall.function?.arguments ||
              toolCall.args ||
              toolCall.input ||
              {};
            return {
              id: toolCall.id || `tool-${Math.random()}`,
              name,
              args,
              status: interrupt ? "interrupted" : ("pending" as const),
            } as ToolCall;
          }
        );
        messageMap.set(message.id!, {
          message,
          toolCalls: toolCallsWithStatus,
        });
      } else if (message.type === "tool") {
        const toolCallId = message.tool_call_id;
        if (!toolCallId) {
          return;
        }
        for (const [, data] of messageMap.entries()) {
          const toolCallIndex = data.toolCalls.findIndex(
            (tc: ToolCall) => tc.id === toolCallId
          );
          if (toolCallIndex === -1) {
            continue;
          }
          data.toolCalls[toolCallIndex] = {
            ...data.toolCalls[toolCallIndex],
            status: "completed" as const,
            result: extractStringFromMessageContent(message),
          };
          break;
        }
      } else if (message.type === "human") {
        messageMap.set(message.id!, {
          message,
          toolCalls: [],
        });
      }
    });
    const processedArray = Array.from(messageMap.values());
    return processedArray.map((data, index) => {
      const prevMessage = index > 0 ? processedArray[index - 1].message : null;
      return {
        ...data,
        showAvatar: data.message.type !== prevMessage?.type,
      };
    });
  }, [messages, interrupt]);

  const groupedTodos = {
    in_progress: todos.filter((t) => t.status === "in_progress"),
    pending: todos.filter((t) => t.status === "pending"),
    completed: todos.filter((t) => t.status === "completed"),
  };

  const hasTasks = todos.length > 0;
  const hasFiles = Object.keys(files).length > 0;

  // Parse out any action requests or review configs from the interrupt
  const actionRequestsMap: Map<string, ActionRequest> | null = useMemo(() => {
    const actionRequests =
      interrupt?.value && (interrupt.value as any)["action_requests"];
    if (!actionRequests) return new Map<string, ActionRequest>();
    return new Map(actionRequests.map((ar: ActionRequest) => [ar.name, ar]));
  }, [interrupt]);

  const reviewConfigsMap: Map<string, ReviewConfig> | null = useMemo(() => {
    const reviewConfigs =
      interrupt?.value && (interrupt.value as any)["review_configs"];
    if (!reviewConfigs) return new Map<string, ReviewConfig>();
    return new Map(
      reviewConfigs.map((rc: ReviewConfig) => [rc.actionName, rc])
    );
  }, [interrupt]);

  const isEmptyState = !isThreadLoading && processedMessages.length === 0 && !isLoading;

  if (isEmptyState) {
    return (
      <div className="flex flex-1 flex-col justify-center items-center pb-28 px-4 max-w-[600px] mx-auto w-full select-none animate-fade-in">
        <div className="text-center mb-6">
          <h1 className="text-3xl font-semibold tracking-tight bg-gradient-to-r from-orange-400 via-primary to-orange-600 bg-clip-text text-transparent pb-1.5 font-serif">
            Hi Legend, what's on your mind?
          </h1>
        </div>
        <div className="w-full">
          <ClaudeChatInput
            ref={chatInputRef}
            onSendMessage={handleSendMessage}
            isLoading={isLoading}
            onStartAgent={onStartAgent}
            onStop={stopStream}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-background">
      <div
        className="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain"
        ref={scrollRef}
      >
        <div
          className="mx-auto w-full max-w-[600px] px-6 pb-6 pt-4"
          ref={contentRef}
        >
          {isThreadLoading ? (
            <div className="flex items-center justify-center p-8">
              <p className="text-muted-foreground">Loading...</p>
            </div>
          ) : (
            <>
              {processedMessages.map((data, index) => {
                const messageUi = ui?.filter(
                  (u: any) => u.metadata?.message_id === data.message.id
                );
                const isLastMessage = index === processedMessages.length - 1;
                return (
                  <ChatMessage
                    key={data.message.id}
                    message={data.message}
                    toolCalls={data.toolCalls}
                    isLoading={isLoading}
                    actionRequestsMap={
                      isLastMessage ? actionRequestsMap : undefined
                    }
                    reviewConfigsMap={
                      isLastMessage ? reviewConfigsMap : undefined
                    }
                    ui={messageUi}
                    stream={stream}
                    onResumeInterrupt={resumeInterrupt}
                    graphId={assistant?.graph_id}
                  />
                );
              })}
              {/* Show animated "Thinking" indicator when agent is running but hasn't produced output yet */}
              {isLoading && processedMessages.length === 0 && (
                <div className="flex items-center gap-2 mt-4 text-muted-foreground text-sm">
                  <span className="inline-flex gap-1">
                    <span className="animate-bounce [animation-delay:0ms] w-1.5 h-1.5 rounded-full bg-primary" />
                    <span className="animate-bounce [animation-delay:150ms] w-1.5 h-1.5 rounded-full bg-primary" />
                    <span className="animate-bounce [animation-delay:300ms] w-1.5 h-1.5 rounded-full bg-primary" />
                  </span>
                  <span>Agent is thinking…</span>
                </div>
              )}
              {/* Show animated dots after the last message if agent is streaming but last message has no AI content yet */}
              {isLoading && processedMessages.length > 0 &&
                processedMessages[processedMessages.length - 1].message.type === "human" && (
                  <div className="flex items-center gap-2 mt-4 text-muted-foreground text-sm">
                    <span className="inline-flex gap-1">
                      <span className="animate-bounce [animation-delay:0ms] w-1.5 h-1.5 rounded-full bg-primary" />
                      <span className="animate-bounce [animation-delay:150ms] w-1.5 h-1.5 rounded-full bg-primary" />
                      <span className="animate-bounce [animation-delay:300ms] w-1.5 h-1.5 rounded-full bg-primary" />
                    </span>
                    <span>Agent is thinking…</span>
                  </div>
                )}
            </>
          )}
        </div>
      </div>

      <div className="flex-shrink-0 bg-background">
        <div className="mx-auto w-full max-w-[600px] px-4 mb-6 flex flex-shrink-0 flex-col transition-all duration-200 ease-in-out">
          {(hasTasks || hasFiles) && (
            <div className="mb-2 flex max-h-72 flex-col overflow-y-auto border border-border rounded-xl bg-sidebar empty:hidden">
              {!metaOpen && (
                <>
                  {(() => {
                    const activeTask = todos.find(
                      (t) => t.status === "in_progress"
                    );

                    const totalTasks = todos.length;
                    const remainingTasks =
                      totalTasks - groupedTodos.pending.length;
                    const isCompleted = totalTasks === remainingTasks;

                    const tasksTrigger = (() => {
                      if (!hasTasks) return null;
                      return (
                        <button
                          type="button"
                          onClick={() =>
                            setMetaOpen((prev) =>
                              prev === "tasks" ? null : "tasks"
                            )
                          }
                          className="grid w-full cursor-pointer grid-cols-[auto_auto_1fr] items-center gap-3 px-[18px] py-3 text-left"
                          aria-expanded={metaOpen === "tasks"}
                        >
                          {(() => {
                            if (isCompleted) {
                              return [
                                <CheckCircle
                                  key="icon"
                                  size={16}
                                  className="text-emerald-500"
                                />,
                                <span
                                  key="label"
                                  className="ml-[1px] min-w-0 truncate text-sm"
                                >
                                  All tasks completed
                                </span>,
                              ];
                            }

                            if (activeTask != null) {
                              return [
                                <div key="icon">
                                  {getStatusIcon(activeTask.status)}
                                </div>,
                                <span
                                  key="label"
                                  className="ml-[1px] min-w-0 truncate text-sm"
                                >
                                  Task{" "}
                                  {totalTasks - groupedTodos.pending.length} of{" "}
                                  {totalTasks}
                                </span>,
                                <span
                                  key="content"
                                  className="min-w-0 gap-2 truncate text-sm text-muted-foreground"
                                >
                                  {activeTask.content}
                                </span>,
                              ];
                            }

                            return [
                              <Circle
                                key="icon"
                                size={16}
                                className="text-muted-foreground/60"
                              />,
                              <span
                                key="label"
                                className="ml-[1px] min-w-0 truncate text-sm"
                              >
                                Task {totalTasks - groupedTodos.pending.length}{" "}
                                of {totalTasks}
                              </span>,
                            ];
                          })()}
                        </button>
                      );
                    })();

                    const filesTrigger = (() => {
                      if (!hasFiles) return null;
                      return (
                        <button
                          type="button"
                          onClick={() =>
                            setMetaOpen((prev) =>
                              prev === "files" ? null : "files"
                            )
                          }
                          className="flex flex-shrink-0 cursor-pointer items-center gap-2 px-[18px] py-3 text-left text-sm"
                          aria-expanded={metaOpen === "files"}
                        >
                          <FileIcon size={16} />
                          Files (State)
                          <span className="h-4 min-w-4 rounded-full bg-primary px-0.5 text-center text-[10px] leading-[16px] text-primary-foreground">
                            {Object.keys(files).length}
                          </span>
                        </button>
                      );
                    })();

                    return (
                      <div className="grid grid-cols-[1fr_auto_auto] items-center">
                        {tasksTrigger}
                        {filesTrigger}
                      </div>
                    );
                  })()}
                </>
              )}

              {metaOpen && (
                <>
                  <div className="sticky top-0 flex items-stretch bg-sidebar text-sm">
                    {hasTasks && (
                      <button
                        type="button"
                        className="py-3 pr-4 first:pl-[18px] aria-expanded:font-semibold"
                        onClick={() =>
                          setMetaOpen((prev) =>
                            prev === "tasks" ? null : "tasks"
                          )
                        }
                        aria-expanded={metaOpen === "tasks"}
                      >
                        Tasks
                      </button>
                    )}
                    {hasFiles && (
                      <button
                        type="button"
                        className="inline-flex items-center gap-2 py-3 pr-4 first:pl-[18px] aria-expanded:font-semibold"
                        onClick={() =>
                          setMetaOpen((prev) =>
                            prev === "files" ? null : "files"
                          )
                        }
                        aria-expanded={metaOpen === "files"}
                      >
                        Files (State)
                        <span className="h-4 min-w-4 rounded-full bg-primary px-0.5 text-center text-[10px] leading-[16px] text-primary-foreground">
                          {Object.keys(files).length}
                        </span>
                      </button>
                    )}
                    <button
                      aria-label="Close"
                      className="flex-1"
                      onClick={() => setMetaOpen(null)}
                    />
                  </div>
                  <div
                    ref={tasksContainerRef}
                    className="px-[18px]"
                  >
                    {metaOpen === "tasks" &&
                      Object.entries(groupedTodos)
                        .filter(([_, todos]) => todos.length > 0)
                        .map(([status, todos]) => (
                          <div
                            key={status}
                            className="mb-4"
                          >
                            <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-tertiary">
                              {
                                {
                                  pending: "Pending",
                                  in_progress: "In Progress",
                                  completed: "Completed",
                                }[status]
                              }
                            </h3>
                            <div className="grid grid-cols-[auto_1fr] gap-3 rounded-sm p-1 pl-0 text-sm">
                              {todos.map((todo, index) => (
                                <Fragment key={`${status}_${todo.id}_${index}`}>
                                  {getStatusIcon(todo.status, "mt-0.5")}
                                  <span className="break-words text-inherit">
                                    {todo.content}
                                  </span>
                                </Fragment>
                              ))}
                            </div>
                          </div>
                        ))}

                    {metaOpen === "files" && (
                      <div className="mb-6">
                        <FilesPopover
                          files={files}
                          setFiles={setFiles}
                          editDisabled={
                            isLoading === true || interrupt !== undefined
                          }
                        />
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
          <ClaudeChatInput
            ref={chatInputRef}
            onSendMessage={handleSendMessage}
            isLoading={isLoading}
            onStartAgent={onStartAgent}
            onStop={stopStream}
          />
        </div>
      </div>
    </div>
  );
});

ChatInterface.displayName = "ChatInterface";
