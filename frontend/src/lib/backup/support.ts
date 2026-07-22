/**
 * Feature detection and ambient types for the File System Access API.
 *
 * These names (`showSaveFilePicker`, `queryPermission`, `requestPermission`) are
 * from the File System Access spec, which TypeScript's DOM lib does not ship
 * because the API is not standardized -- Firefox and Safari have declined to
 * implement the picker half (they support only the sandboxed OPFS). So silent
 * auto-backup to a real disk file is Chromium-only, and everything here is
 * guarded behind `supportsFileSystemAccess()`; other browsers fall back to the
 * manual JSON export, which works everywhere.
 */

export interface SaveFilePickerType {
  description?: string;
  accept: Record<string, string[]>;
}

export interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: SaveFilePickerType[];
  id?: string;
}

export type PermissionState = 'granted' | 'denied' | 'prompt';

export interface FileSystemHandlePermissionDescriptor {
  mode?: 'read' | 'readwrite';
}

declare global {
  interface Window {
    showSaveFilePicker?(options?: SaveFilePickerOptions): Promise<FileSystemFileHandle>;
  }
  interface FileSystemFileHandle {
    queryPermission?(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
    requestPermission?(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  }
}

/** True only where a page can write to a user-chosen file outside browser storage. */
export function supportsFileSystemAccess(): boolean {
  return typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';
}
