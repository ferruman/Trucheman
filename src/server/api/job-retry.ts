import { Router } from "express";
export function jobRetryRouter(){const r=Router();r.post("/:id/retry",(_q,res)=>res.status(202).json({accepted:true}));return r;}
