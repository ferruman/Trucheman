import { Router } from "express";
export function jobControlRouter(){const r=Router();r.post("/:id/pause",(_q,res)=>res.json({status:"stopping"}));r.post("/:id/resume",(_q,res)=>res.json({status:"running"}));r.post("/:id/invalidate",(_q,res)=>res.json({ok:true}));return r;}
