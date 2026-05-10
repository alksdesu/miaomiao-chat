/**
 * 解析 OpenAI/Claude 格式的用户消息内容
 * 从多部分内容中提取文本和附件（图片/PDF）
 */

/**
 * @param {string|Array} content - 消息内容
 * @returns {Object} { text, images } images 是附件数组，命名保持向后兼容
 */
export function parseUserContent(content) {
    let text = '';
    const attachments = [];

    if (Array.isArray(content)) {
        content.forEach((part) => {
            if (part.type === 'text') {
                text += (text ? '\n' : '') + (part.text || '');
            } else if (part.type === 'image_url' && part.image_url?.url) {
                // 图片（OpenAI 格式）
                attachments.push({
                    name: '已上传图片',
                    type: 'image/*',
                    category: 'image',
                    data: part.image_url.url
                });
            } else if (part.type === 'image' && part.source?.data) {
                // 图片（Claude 格式）
                const mimeType = part.source.media_type || 'image/*';
                attachments.push({
                    name: '已上传图片',
                    type: mimeType,
                    category: 'image',
                    data: `data:${mimeType};base64,${part.source.data}`
                });
            } else if (part.type === 'file' && part.file?.file_data) {
                // PDF（OpenAI 格式）
                attachments.push({
                    name: part.file.filename || '已上传PDF',
                    type: 'application/pdf',
                    category: 'pdf',
                    data: part.file.file_data
                });
            } else if (part.type === 'document' && part.source?.data) {
                // PDF（Claude 格式）
                const mimeType = part.source.media_type || 'application/pdf';
                attachments.push({
                    name: '已上传PDF',
                    type: mimeType,
                    category: 'pdf',
                    data: `data:${mimeType};base64,${part.source.data}`
                });
            }
        });
    } else if (typeof content === 'string') {
        text = content;
    }

    return { text, images: attachments };
}
