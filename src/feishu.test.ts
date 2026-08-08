import { describe, expect, it } from 'vitest';
import { parseDocumentUrl } from './feishu.js';

describe('parseDocumentUrl', () => {
  it('解析新版 docx 链接并移除查询参数', () => {
    expect(parseDocumentUrl('https://example.feishu.cn/docx/AbC_123?from=comment')).toEqual({
      fileToken: 'AbC_123', fileType: 'docx', url: 'https://example.feishu.cn/docx/AbC_123',
    });
  });

  it('拒绝未支持的 wiki 链接', () => {
    expect(parseDocumentUrl('https://example.feishu.cn/wiki/AbC123')).toBeNull();
  });
});
