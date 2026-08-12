import fs from "node:fs";
import path from "node:path";
import {
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";

const outputPath = process.argv[2];
if (!outputPath) {
  throw new Error("Usage: node create-xleth-filter-design.js /absolute/path/output.docx");
}

const mdPath = path.join(path.dirname(outputPath), "xleth-filter-design.md");
const md = fs.readFileSync(mdPath, "utf8");

// ---- Style contract ---------------------------------------------------------
const HEADING_COLOR = "4F81BD";
const bodyFont = { ascii: "DejaVu Serif", hAnsi: "DejaVu Serif", cs: "DejaVu Serif" };
const headingFont = { ascii: "Carlito", hAnsi: "Carlito", cs: "Carlito" };
const codeFont = { ascii: "Noto Sans Mono", hAnsi: "Noto Sans Mono", cs: "Noto Sans Mono" };
const SIZE_BODY = 22; // 11pt
const SIZE_CODE = 20; // 10pt

// ---- Inline markdown -> runs ------------------------------------------------
function parseInline(text) {
  const runs = [];
  let i = 0;
  let bold = false;
  let italic = false;
  let buf = "";
  const flush = () => {
    if (buf) {
      runs.push({ text: buf, bold, italic, code: false });
      buf = "";
    }
  };
  while (i < text.length) {
    if (text[i] === "`") {
      const j = text.indexOf("`", i + 1);
      if (j === -1) {
        buf += text[i];
        i++;
        continue;
      }
      flush();
      runs.push({ text: text.slice(i + 1, j), bold, italic, code: true });
      i = j + 1;
    } else if (text.startsWith("**", i)) {
      flush();
      bold = !bold;
      i += 2;
    } else if (text[i] === "*") {
      const j = text.indexOf("*", i + 1);
      if (j !== -1) {
        flush();
        italic = !italic;
        i++;
      } else {
        buf += "*";
        i++;
      }
    } else {
      buf += text[i];
      i++;
    }
  }
  flush();
  return runs;
}

const runsFromInline = (text, { forceBold = false, size = SIZE_BODY } = {}) =>
  parseInline(text).map(
    (t) =>
      new TextRun({
        text: t.text,
        bold: forceBold || t.bold || undefined,
        italics: t.italic || undefined,
        font: t.code ? codeFont : bodyFont,
        size: t.code ? SIZE_CODE : size,
        color: "000000",
      })
  );

// ---- Block parser -----------------------------------------------------------
const lines = md.split(/\r?\n/);
const blocks = [];
let i = 0;
while (i < lines.length) {
  const line = lines[i];
  if (!line.trim()) {
    i++;
    continue;
  }
  if (line.startsWith("```")) {
    const code = [];
    i++;
    while (i < lines.length && !lines[i].startsWith("```")) {
      code.push(lines[i]);
      i++;
    }
    i++;
    blocks.push({ type: "code", lines: code });
  } else if (/^#{1,4}\s/.test(line)) {
    const level = line.match(/^#+/)[0].length;
    blocks.push({ type: "heading", level, text: line.replace(/^#+\s*/, "") });
    i++;
  } else if (/^---+\s*$/.test(line)) {
    blocks.push({ type: "hr" });
    i++;
  } else if (line.startsWith("|")) {
    const rows = [];
    while (i < lines.length && lines[i].startsWith("|")) {
      rows.push(lines[i]);
      i++;
    }
    const parseRow = (r) =>
      r
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((s) => s.trim());
    blocks.push({ type: "table", header: parseRow(rows[0]), body: rows.slice(2).map(parseRow) });
  } else if (/^- /.test(line)) {
    const items = [];
    while (i < lines.length && /^- /.test(lines[i])) {
      items.push(lines[i].slice(2));
      i++;
    }
    blocks.push({ type: "bullets", items });
  } else {
    const plines = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,4}\s|---+\s*$|\||- |```)/.test(lines[i])
    ) {
      plines.push(lines[i]);
      i++;
    }
    blocks.push({ type: "para", text: plines.join(" ") });
  }
}

// ---- Renderers --------------------------------------------------------------
const para = (children, options = {}) =>
  new Paragraph({
    spacing: { after: 140, line: 276 },
    ...options,
    children: Array.isArray(children) ? children : [children],
  });

const headingPara = (text, level) => {
  if (level === 1) {
    return para([new TextRun({ text, bold: true, font: headingFont, size: 32, color: HEADING_COLOR })], {
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 0, after: 200 },
    });
  }
  if (level === 2) {
    return para([new TextRun({ text, bold: true, font: headingFont, size: 28, color: HEADING_COLOR })], {
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 280, after: 140 },
    });
  }
  // H3/H4: Carlito bold, 12pt, black
  return para([new TextRun({ text, bold: true, font: headingFont, size: 24, color: "000000" })], {
    heading: level === 3 ? HeadingLevel.HEADING_3 : HeadingLevel.HEADING_4,
    spacing: { before: 220, after: 120 },
  });
};

const hrPara = () =>
  new Paragraph({
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "808080", space: 1 } },
    spacing: { before: 120, after: 200 },
    children: [],
  });

const codeParas = (codeLines) =>
  codeLines.map(
    (cl, idx) =>
      new Paragraph({
        spacing: { after: idx === codeLines.length - 1 ? 160 : 0, line: 240 },
        indent: { left: 360 },
        children: [new TextRun({ text: cl.length ? cl : " ", font: codeFont, size: SIZE_CODE, color: "000000" })],
      })
  );

const thin = { style: BorderStyle.SINGLE, size: 4, color: "000000" };
const none = { style: BorderStyle.NONE, size: 0, color: "000000" };

const tableBlock = ({ header, body }) => {
  const colCount = header.length;
  const widths =
    colCount === 3 ? [3800, 4200, 1360] : colCount === 4 ? [560, 2700, 4600, 1500] : null;
  const cellWidth = (c) =>
    widths ? { size: widths[c], type: WidthType.DXA } : undefined;

  const cell = (text, { headerCell = false, col = 0 } = {}) =>
    new TableCell({
      children: [
        para(runsFromInline(text, { forceBold: headerCell }), { spacing: { after: 0, line: 252 } }),
      ],
      margins: { top: 80, bottom: 80, left: 120, right: 120 },
      width: cellWidth(col),
      borders: headerCell ? { bottom: thin } : undefined,
    });

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: widths || undefined,
    borders: {
      top: thin,
      bottom: thin,
      left: none,
      right: none,
      insideHorizontal: none,
      insideVertical: none,
    },
    rows: [
      new TableRow({
        tableHeader: true,
        children: header.map((h, c) => cell(h, { headerCell: true, col: c })),
      }),
      ...body.map(
        (r) => new TableRow({ children: r.map((t, c) => cell(t, { col: c })) })
      ),
    ],
  });
};

// ---- Assemble ---------------------------------------------------------------
const children = [];
for (const block of blocks) {
  if (block.type === "heading") {
    children.push(headingPara(block.text, block.level));
  } else if (block.type === "hr") {
    children.push(hrPara());
  } else if (block.type === "code") {
    children.push(...codeParas(block.lines));
  } else if (block.type === "table") {
    children.push(para([new TextRun({ text: " ", size: 2 })], { spacing: { after: 40, line: 40 } }));
    children.push(tableBlock(block));
    children.push(para([new TextRun({ text: " ", size: 2 })], { spacing: { after: 120, line: 40 } }));
  } else if (block.type === "bullets") {
    for (const item of block.items) {
      children.push(para(runsFromInline(item), { bullet: { level: 0 }, spacing: { after: 100, line: 276 } }));
    }
  } else if (block.type === "para") {
    children.push(para(runsFromInline(block.text)));
  }
}

const doc = new Document({
  features: { updateFields: false },
  sections: [
    {
      properties: {
        page: {
          margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 },
        },
      },
      children,
    },
  ],
});

const buffer = await Packer.toBuffer(doc);
fs.writeFileSync(outputPath, buffer);
