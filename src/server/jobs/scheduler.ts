export class Scheduler{
  private active?:{key:string;promise:Promise<unknown>};

  schedule<T>(key:string,task:()=>Promise<T>):{started:boolean;promise:Promise<T>}{
    if(this.active){
      if(this.active.key===key)return {started:false,promise:this.active.promise as Promise<T>};
      throw new Error("Another job is already active");
    }
    const promise=Promise.resolve().then(task).finally(()=>{if(this.active?.promise===promise)this.active=undefined;});
    this.active={key,promise};
    return {started:true,promise};
  }

  async run<T>(task:()=>Promise<T>):Promise<T>{return this.schedule("default",task).promise;}
  isActive(key:string){return this.active?.key===key;}
  get activeKey(){return this.active?.key;}
  get busy(){return Boolean(this.active);}
}
