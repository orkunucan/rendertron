'use strict';

import * as Koa from 'koa';
import * as fs from 'fs';
import * as path from 'path';

type CacheContent = {
    saved: Date,
    headers: string,
    payload: string,
};

const cachePrefix = 'cache';
const cacheTimeout = 1000 * 60 * 5; // 5 minutes

export class FileCache {
    /**
     *
     */
    constructor() {
        const rootPath = path.join(__dirname, cachePrefix);
        if (!fs.existsSync(rootPath)) {
            fs.mkdirSync(rootPath);
        }
    }

    async clearCache() {
        const rootPath = path.join(__dirname, cachePrefix);

        const files = fs.readdirSync(rootPath);

        for (const file of files) {
            fs.unlinkSync(file);
        }
    }

    async cacheContent(key: string, headers: { [key: string]: string }, payload: Buffer) {

        //remove refreshCache from URL
        let cacheKey = key
            .replace(/&?refreshCache=(?:true|false)&?/i, '');

        if (cacheKey.charAt(cacheKey.length - 1) === '?') {
            cacheKey = cacheKey.slice(0, -1);
        }

        cacheKey = Buffer.from(cacheKey).toString('base64');

        const headerPath = path.join(__dirname, cachePrefix, `${cacheKey}.header`);
        const payloadPath = path.join(__dirname, cachePrefix, `${cacheKey}.payload`);

        await new Promise((resolve, reject) => {

            fs.writeFile(headerPath, JSON.stringify(headers), (err) => {
                if (err) {
                    reject(`could not open file: ${err}`);
                }
                resolve();
            });
        });

        await new Promise((resolve, reject) => {

            fs.writeFile(payloadPath, payload.toString(), (err) => {
                if (err) {
                    reject(`could not open file: ${err}`);
                }
                resolve();
            });
        });
    }

    async fileExists(headerPath: string): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            fs.exists(headerPath, (e) => resolve(e));
        });
    }

    async getCachedContent(ctx: Koa.Context, key: string) {
        if (ctx.query.refreshCache) {
            return;
        }

        key = Buffer.from(key).toString('base64');

        const headerPath = path.join(__dirname, cachePrefix, `${key}.header`);
        const payloadPath = path.join(__dirname, cachePrefix, `${key}.payload`);

        if (!await this.fileExists(headerPath) || !await this.fileExists(payloadPath)) {
            return;
        }

        const saved = await new Promise<Date>((resolve, reject) => {
            fs.stat(payloadPath, (err, stats) => {
                if (err) {
                    reject(`could not open file: ${err}`);
                }
                resolve(new Date(stats.ctime));
            });
        });

        if (saved.getTime() + cacheTimeout < new Date().getTime()) {
            return;
        }
        const headers = await new Promise<string>((resolve, reject) => {
            fs.readFile(headerPath, (err, data) => {
                if (err) {
                    reject(`could not open file: ${err}`);
                }

                resolve(data.toString());
            });
        });

        const payload = await new Promise<string>((resolve, reject) => {
            fs.readFile(payloadPath, (err, data) => {
                if (err) {
                    reject(`could not open file: ${err}`);
                }

                resolve(data.toString());
            });
        });

        return {
            headers: headers,
            payload: payload,
            saved: saved
        } as CacheContent;
    }

    middleware() {
        return this.handleRequest.bind(this);
    }

    private async handleRequest(ctx: Koa.Context, next: () => Promise<unknown>) {
        const cacheKey = ctx.url;
        const cachedContent = await this.getCachedContent(ctx, cacheKey);
        if (cachedContent) {
            const headers = JSON.parse(cachedContent.headers);
            ctx.set(headers);
            ctx.set('x-rendertron-cached', cachedContent.saved.toUTCString());
            try {
                ctx.body = cachedContent.payload;
                return;
            } catch (error) {
                console.log(
                    'Erroring parsing cache contents, falling back to normal render');
            }
        }

        await next();

        if (ctx.status === 200) {
            await this.cacheContent(cacheKey, ctx.response.headers, ctx.body);
        }
    }
}
