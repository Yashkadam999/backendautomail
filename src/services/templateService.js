import Handlebars from "handlebars";

export function extractTemplateVariables(content = "") {
  const variablePattern = /{{\s*([a-zA-Z0-9_.-]+)\s*}}/g;
  const matches = content.matchAll(variablePattern);
  return [...new Set(Array.from(matches, (match) => match[1]))];
}

export function renderTemplate(content, payload) {
  const compiled = Handlebars.compile(content || "");
  return compiled(payload || {});
}

function appendStyle(existingStyle = "", nextStyle = "") {
  const normalizedExisting = String(existingStyle || "").trim();
  const normalizedNext = String(nextStyle || "").trim();

  if (!normalizedExisting) {
    return normalizedNext;
  }

  if (!normalizedNext) {
    return normalizedExisting;
  }

  return `${normalizedExisting}; ${normalizedNext}`;
}

function inlineStylesFromQuillClassName(className = "") {
  const classes = String(className || "")
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean);

  const styleParts = [];

  classes.forEach((token) => {
    if (token === "ql-size-small") {
      styleParts.push("font-size:12px");
    }

    if (token === "ql-size-large") {
      styleParts.push("font-size:18px");
    }

    if (token === "ql-size-huge") {
      styleParts.push("font-size:28px");
    }

    if (token === "ql-font-serif") {
      styleParts.push("font-family:Georgia, 'Times New Roman', serif");
    }

    if (token === "ql-font-monospace") {
      styleParts.push("font-family:Menlo, Monaco, Consolas, 'Courier New', monospace");
    }

    if (token === "ql-align-center") {
      styleParts.push("text-align:center");
    }

    if (token === "ql-align-right") {
      styleParts.push("text-align:right");
    }

    if (token === "ql-align-justify") {
      styleParts.push("text-align:justify");
    }

    if (token === "ql-direction-rtl") {
      styleParts.push("direction:rtl");
    }

    const indentMatch = token.match(/^ql-indent-(\d+)$/);
    if (indentMatch) {
      const level = Number(indentMatch[1]) || 0;
      if (level > 0) {
        styleParts.push(`margin-left:${level * 2}em`);
      }
    }
  });

  return styleParts.join("; ");
}

function replaceClassWithInlineStyle(html = "") {
  return String(html || "").replace(/class="([^"]+)"/g, (fullMatch, className) => {
    const styleFromClass = inlineStylesFromQuillClassName(className);
    if (!styleFromClass) {
      return "";
    }

    return `style="${styleFromClass}"`;
  });
}

function mergeExistingStyleAndClass(html = "") {
  return String(html || "").replace(
    /style="([^"]*)"\s+class="([^"]+)"|class="([^"]+)"\s+style="([^"]*)"/g,
    (_match, styleA, classA, classB, styleB) => {
      const existingStyle = styleA || styleB || "";
      const className = classA || classB || "";
      const styleFromClass = inlineStylesFromQuillClassName(className);
      const mergedStyle = appendStyle(existingStyle, styleFromClass);

      if (!mergedStyle) {
        return "";
      }

      return `style="${mergedStyle}"`;
    }
  );
}

export function formatRichTextEmailHtml(content = "") {
  const rendered = String(content || "").trim();
  if (!rendered) {
    return "";
  }

  const withInlineStyle = (tagName, attrs, styleToAppend) => {
    const attributes = String(attrs || "");

    if (/style="([^"]*)"/i.test(attributes)) {
      return `<${tagName}${attributes.replace(/style="([^"]*)"/i, (_styleMatch, existingStyle) => `style="${appendStyle(existingStyle, styleToAppend)}"`)}>`;
    }

    return `<${tagName}${attributes} style="${styleToAppend}">`;
  };

  const withMergedStyles = mergeExistingStyleAndClass(rendered);
  const inlineStyledHtml = replaceClassWithInlineStyle(withMergedStyles)
    .replace(/<p\b([^>]*)>/gi, (_match, attrs) => withInlineStyle("p", attrs, "margin:0"))
    .replace(/<ul\b([^>]*)>/gi, (_match, attrs) => withInlineStyle("ul", attrs, "margin-top:0; margin-bottom:0"))
    .replace(/<ol\b([^>]*)>/gi, (_match, attrs) => withInlineStyle("ol", attrs, "margin-top:0; margin-bottom:0"))
    .replace(/<li\b([^>]*)>/gi, (_match, attrs) => withInlineStyle("li", attrs, "margin:0"))
    .replace(/<p><br><\/p>/g, "<p>&nbsp;</p>")
    .replace(/<p><\/p>/g, "<p>&nbsp;</p>");

  return `<div style="font-family:Arial, Helvetica, sans-serif; font-size:14px; line-height:1.6; color:#1f2937;">${inlineStyledHtml}</div>`;
}

export function htmlToPlainText(content = "") {
  return String(content || "")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<(ul|ol|table|thead|tbody|tfoot)>/gi, "\n")
    .replace(/<li>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}
