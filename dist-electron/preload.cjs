var a=Object.defineProperty;var c=Object.getOwnPropertyDescriptor;var s=Object.getOwnPropertyNames;var p=Object.prototype.hasOwnProperty;var g=(n,e,o,t)=>{if(e&&typeof e=="object"||typeof e=="function")for(let r of s(e))!p.call(n,r)&&r!==o&&a(n,r,{get:()=>e[r],enumerable:!(t=c(e,r))||t.enumerable});return n};var d=n=>g(a({},"__esModule",{value:!0}),n);var I={};module.exports=d(I);var i=require("electron");var l={invoke:(n,e,o)=>i.ipcRenderer.invoke("api:ipc",{channel:n,payload:e,token:o})};i.contextBridge.exposeInMainWorld("electronAPI",l);
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Secure Preload Script for Electron Desktop POS.
 * Enforces contextIsolation: true and nodeIntegration: false.
 * Only exposes strict, typed electronAPI.invoke to renderer window.
 */
