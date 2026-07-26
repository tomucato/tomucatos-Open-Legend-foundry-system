

export function numberGuard(number){
   return Math.max(0, Math.floor(Number(number) || 0));
}