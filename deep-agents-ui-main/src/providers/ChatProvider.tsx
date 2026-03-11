"use client";

import { ReactNode, createContext, useContext, useEffect } from "react";
import { Assistant } from "@langchain/langgraph-sdk";
import { type StateType, useChat } from "@/app/hooks/useChat";
import type { UseStreamThread } from "@langchain/langgraph-sdk/react";

interface ChatProviderProps {
  children: ReactNode;
  activeAssistant: Assistant | null;
  onHistoryRevalidate?: () => void;
  thread?: UseStreamThread<StateType>;
  /** If provided, will be populated with stream.submit so the parent can call it directly */
  submitRef?: React.MutableRefObject<((input: any, options?: any) => void) | null>;
  /** Called when the stream finishes (success or error) */
  onStreamFinish?: () => void;
  /** Called when the stream errors */
  onStreamError?: () => void;
}

export function ChatProvider({
  children,
  activeAssistant,
  onHistoryRevalidate,
  thread,
  submitRef,
  onStreamFinish,
  onStreamError,
}: ChatProviderProps) {
  const chat = useChat({
    activeAssistant,
    onHistoryRevalidate,
    thread,
    onFinishCallback: onStreamFinish,
    onErrorCallback: onStreamError,
  });

  // Expose stream.submit to parent via ref
  useEffect(() => {
    if (submitRef) {
      submitRef.current = chat.stream.submit;
    }
  }, [submitRef, chat.stream.submit]);

  return <ChatContext.Provider value={chat}>{children}</ChatContext.Provider>;
}

export type ChatContextType = ReturnType<typeof useChat>;

export const ChatContext = createContext<ChatContextType | undefined>(
  undefined
);

export function useChatContext() {
  const context = useContext(ChatContext);
  if (context === undefined) {
    throw new Error("useChatContext must be used within a ChatProvider");
  }
  return context;
}
