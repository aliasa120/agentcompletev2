"use client";

import { StreamdownTextPrimitive } from "@assistant-ui/react-streamdown";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { cjk } from "@streamdown/cjk";

import "katex/dist/katex.min.css";
import "streamdown/styles.css";

export function MarkdownText() {
  return (
    <StreamdownTextPrimitive
      plugins={{ code, math, mermaid, cjk }}
      shikiTheme={["github-light", "github-dark"]}
      caret="block"
      containerClassName="aui-md"
    />
  );
}
