
import * as pdfjsLib from 'pdfjs-dist';
import mammoth from 'mammoth';

// Set up PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;

export type SupportedFileType = 'image' | 'pdf' | 'docx' | 'text' | 'unsupported';

/**
 * Detect file type from a File object.
 */
export const detectFileType = (file: File): SupportedFileType => {
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();

  // Images
  if (type.startsWith('image/') || /\.(png|jpg|jpeg|gif|webp|bmp|svg)$/.test(name)) {
    return 'image';
  }

  // PDF
  if (type === 'application/pdf' || name.endsWith('.pdf')) {
    return 'pdf';
  }

  // DOCX (Word)
  if (
    type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    name.endsWith('.docx')
  ) {
    return 'docx';
  }

  // Plain text, code files, markdown, CSV, JSON, etc.
  if (
    type.startsWith('text/') ||
    type === 'application/json' ||
    type === 'application/xml' ||
    /\.(txt|md|csv|json|xml|html|css|js|ts|tsx|jsx|py|java|c|cpp|h|rb|go|rs|sh|yaml|yml|toml|ini|cfg|log|sql|env)$/.test(name)
  ) {
    return 'text';
  }

  return 'unsupported';
};

/**
 * Get a user-friendly label for the file type.
 */
export const getFileTypeLabel = (fileType: SupportedFileType): string => {
  switch (fileType) {
    case 'image': return 'Image';
    case 'pdf': return 'PDF Document';
    case 'docx': return 'Word Document';
    case 'text': return 'Text File';
    case 'unsupported': return 'Unsupported File';
  }
};

/**
 * Extract text content from a PDF file.
 */
const extractPdfText = async (file: File): Promise<string> => {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const textParts: string[] = [];

  const maxPages = Math.min(pdf.numPages, 50); // Cap at 50 pages to avoid huge payloads
  for (let i = 1; i <= maxPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item: any) => item.str)
      .join(' ');
    if (pageText.trim()) {
      textParts.push(`[Page ${i}]\n${pageText}`);
    }
  }

  if (pdf.numPages > maxPages) {
    textParts.push(`\n[... ${pdf.numPages - maxPages} more pages not shown ...]`);
  }

  return textParts.join('\n\n') || 'Could not extract text from this PDF.';
};

/**
 * Extract text content from a DOCX file.
 */
const extractDocxText = async (file: File): Promise<string> => {
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value || 'Could not extract text from this document.';
};

/**
 * Extract text content from a plain text file.
 */
const extractTextContent = async (file: File): Promise<string> => {
  return await file.text();
};

/**
 * Parse a file and extract its text content for analysis.
 * Returns the extracted text and metadata.
 */
export const parseFile = async (file: File): Promise<{
  text: string;
  fileType: SupportedFileType;
  fileName: string;
  truncated: boolean;
}> => {
  const fileType = detectFileType(file);
  const fileName = file.name;
  let text = '';
  let truncated = false;

  switch (fileType) {
    case 'pdf':
      text = await extractPdfText(file);
      break;
    case 'docx':
      text = await extractDocxText(file);
      break;
    case 'text':
      text = await extractTextContent(file);
      break;
    case 'image':
      // Images are handled separately via vision model
      text = '';
      break;
    case 'unsupported':
      text = `Unsupported file type: ${file.type || 'unknown'}. Supported formats: images (PNG, JPG, etc.), PDF, DOCX, and text files (TXT, MD, CSV, JSON, code files).`;
      break;
  }

  // Truncate very large text to avoid exceeding token limits
  const MAX_CHARS = 15000;
  if (text.length > MAX_CHARS) {
    text = text.slice(0, MAX_CHARS) + `\n\n[... Content truncated at ${MAX_CHARS} characters. Original file: ${(text.length / 1000).toFixed(0)}K chars ...]`;
    truncated = true;
  }

  return { text, fileType, fileName, truncated };
};
