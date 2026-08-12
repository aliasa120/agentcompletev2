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
      // Streamdown's link-safety confirmation dialog renders its overlay INLINE
      // inside the markdown <p> that contains the link (fixed-position div with
      // nested <div>/<p>), which is invalid HTML nesting and triggers React
      // hydration errors ("><p> cannot contain a nested <p>"). Disable it so
      // links render as plain anchors — sanitization (rehype-sanitize + harden)
      // still applies, and the app has its own file/download cards.
      linkSafety={{ enabled: false }}
    />
  );
}
