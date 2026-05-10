/**
 * 会话文件夹 CRUD
 */

import { state } from '../core/state.js';
import { setFolders } from '../core/state-mutations.js';
import { eventBus } from '../core/events.js';
import { logger } from '../utils/logger.js';
import { generateId } from '../utils/helpers.js';
import { STORES, getDB, initDB, saveSessionToDB } from './storage.js';

async function ensureDB() {
    if (!getDB()) {
        await initDB();
        if (!getDB()) throw new Error('数据库未初始化');
    }
}

function folderTransaction(mode = 'readonly') {
    const tx = getDB().transaction([STORES.FOLDERS], mode);
    return tx.objectStore(STORES.FOLDERS);
}

async function saveFolderToDB(folder) {
    await ensureDB();
    return new Promise((resolve, reject) => {
        const store = folderTransaction('readwrite');
        const request = store.put(folder);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

async function loadAllFoldersFromDB() {
    await ensureDB();
    return new Promise((resolve, reject) => {
        const store = folderTransaction('readonly');
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
    });
}

async function deleteFolderFromDB(id) {
    await ensureDB();
    return new Promise((resolve, reject) => {
        const store = folderTransaction('readwrite');
        const request = store.delete(id);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

export async function loadFolders() {
    try {
        const folders = await loadAllFoldersFromDB();
        folders.sort((a, b) => a.order - b.order);
        setFolders(folders);
        logger.debug(`加载了 ${folders.length} 个文件夹`);
    } catch (e) {
        logger.error('加载文件夹失败:', e);
        setFolders([]);
    }
}

export async function createFolder(name) {
    const folder = {
        id: generateId('folder'),
        name,
        order: state.folders.length,
        collapsed: false,
        createdAt: Date.now()
    };

    await saveFolderToDB(folder);
    setFolders([...state.folders, folder]);
    eventBus.emit('folders:changed');
    logger.debug(`创建文件夹: ${name}`);
    return folder;
}

export async function renameFolder(id, newName) {
    const idx = state.folders.findIndex((f) => f.id === id);
    if (idx === -1) return;

    const updated = { ...state.folders[idx], name: newName };
    await saveFolderToDB(updated);
    const folders = [...state.folders];
    folders[idx] = updated;
    setFolders(folders);
    eventBus.emit('folders:changed');
}

export async function deleteFolder(id) {
    await deleteFolderFromDB(id);

    const affected = state.sessions.filter((s) => s.folderId === id);
    for (const session of affected) {
        session.folderId = null;
        try {
            await saveSessionToDB(session);
        } catch (e) {
            logger.error(`保存会话 ${session.id} 失败:`, e);
        }
    }

    setFolders(state.folders.filter((f) => f.id !== id));
    eventBus.emit('folders:changed');
    if (affected.length > 0) {
        eventBus.emit('sessions:updated');
    }
}

export async function reorderFolders(orderedIds) {
    const folderMap = new Map(state.folders.map((f) => [f.id, f]));
    const reordered = [];

    for (let i = 0; i < orderedIds.length; i++) {
        const folder = folderMap.get(orderedIds[i]);
        if (folder) {
            const updated = { ...folder, order: i };
            reordered.push(updated);
            await saveFolderToDB(updated);
        }
    }

    setFolders(reordered);
    eventBus.emit('folders:changed');
}

export async function toggleFolderCollapse(id) {
    const idx = state.folders.findIndex((f) => f.id === id);
    if (idx === -1) return;

    const updated = { ...state.folders[idx], collapsed: !state.folders[idx].collapsed };
    await saveFolderToDB(updated);
    const folders = [...state.folders];
    folders[idx] = updated;
    setFolders(folders);
    eventBus.emit('folders:changed');
}

export async function moveSessionToFolder(sessionId, folderId) {
    const session = state.sessions.find((s) => s.id === sessionId);
    if (!session) return;
    if (session.folderId === folderId) return;

    session.folderId = folderId;
    try {
        await saveSessionToDB(session);
    } catch (e) {
        logger.error(`保存会话 ${sessionId} 失败:`, e);
    }
    eventBus.emit('sessions:updated');
}
