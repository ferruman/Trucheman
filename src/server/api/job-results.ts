import { Router } from "express";
export function jobResultsRouter(){const r=Router();r.get("/:id/results",(_q,res)=>res.json({validation:null,statistics:null}));r.post("/:id/rebuild",(_q,res)=>res.status(202).json({accepted:true}));return r;}
