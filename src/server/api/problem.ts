import type { Request, Response } from "express";
import { safeError } from "../domain/errors.js";
export function problemResponse(res:Response,error:unknown,req?:Request){const e=safeError(error);return res.status(e.status).type("application/problem+json").json({type:`https://book-translator.local/problems/${e.code}`,title:e.code,status:e.status,detail:e.message,instance:req?.originalUrl});}
