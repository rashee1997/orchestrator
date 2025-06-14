declare module 'better-sqlite3' {
  import { EventEmitter } from 'events';

  export interface DatabaseOptions {
    readonly memory?: boolean;
    readonly readonly?: boolean;
    readonly fileMustExist?: boolean;
    readonly timeout?: number;
    readonly verbose?: (...args: any[]) => void;
  }

  export interface Statement {
    run(...params: any[]): any;
    get(...params: any[]): any;
    all(...params: any[]): any[];
    iterate(...params: any[]): IterableIterator<any>;
    bind(...params: any[]): this;
    reset(): this;
    finalize(): void;
    safeIntegers(enable?: boolean): this;
  }

  export interface Database extends EventEmitter {
    readonly memory: boolean;
    readonly readonly: boolean;
    readonly open: boolean;
    readonly inTransaction: boolean;

    prepare(sql: string): Statement;
    exec(sql: string): Database;
    close(): void;
    loadExtension(path: string): void;
    pragma(options: string | { readonly: boolean }): any;

    transaction(fn: Function): Function;
  }

  export default class BetterSqlite3 {
    constructor(filename: string, options?: DatabaseOptions);
    prepare(sql: string): Statement;
    exec(sql: string): Database;
    close(): void;
    loadExtension(path: string): void;
    pragma(options: string | { readonly: boolean }): any;
  }
}
