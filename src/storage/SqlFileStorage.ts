import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export class SqlFileStorage {
  private baseDir: string;

  constructor() {
    this.baseDir = path.join(os.homedir(), '.simpledb');
    // onLanguage:sql 활성화로 일반 SQL 파일을 열어도 확장이 구동되므로
    // 디렉터리 생성은 실제 파일 조작 시점으로 미룬다.
  }

  private connectionDir(connectionId: string): string {
    const dir = path.join(this.baseDir, connectionId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  getSqlFileNames(connectionId: string): string[] {
    const dir = this.connectionDir(connectionId);
    try {
      return fs.readdirSync(dir).filter((f) => f.endsWith('.sql'));
    } catch {
      return [];
    }
  }

  private sanitizeFileName(name: string): string {
    // baseDir 밖으로 벗어나는 경로 구분자·상위 참조를 제거한다(경로 순회 방지)
    const base = path.basename(name.trim());
    if (!base || base === '.' || base === '..') {
      throw new Error('올바르지 않은 파일 이름입니다.');
    }
    return base;
  }

  async createSqlFile(connectionId: string, name: string): Promise<string> {
    name = this.sanitizeFileName(name);
    if (!name.endsWith('.sql')) {
      name += '.sql';
    }

    const dir = this.connectionDir(connectionId);
    let filePath = path.join(dir, name);

    if (fs.existsSync(filePath)) {
      const base = name.replace(/\.sql$/, '');
      name = `${base}_${Date.now()}.sql`;
      filePath = path.join(dir, name);
    }

    fs.writeFileSync(filePath, '');
    return name;
  }

  async deleteSqlFile(connectionId: string, name: string): Promise<void> {
    const filePath = path.join(this.connectionDir(connectionId), name);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  async saveContent(connectionId: string, name: string, content: string): Promise<void> {
    const filePath = path.join(this.connectionDir(connectionId), name);
    fs.writeFileSync(filePath, content, 'utf-8');
  }

  getContent(connectionId: string, name: string): string {
    const filePath = path.join(this.connectionDir(connectionId), name);
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      return '';
    }
  }

  filePath(connectionId: string, name: string): string {
    return path.join(this.connectionDir(connectionId), name);
  }

  connectionIdFromPath(filePath: string): string | null {
    const relative = path.relative(this.baseDir, filePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return null;
    }
    const parts = relative.split(path.sep);
    if (parts.length >= 2) {
      return parts[0];
    }
    return null;
  }
}
