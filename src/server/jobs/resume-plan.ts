export function firstUnfinished<T extends {status:string}>(steps:T[]):number{const i=steps.findIndex(step=>step.status!=="completed");return i<0?steps.length:i;}
