import {createFileRoute, Outlet} from "@tanstack/react-router";
export const Route=createFileRoute("/admin")({component:Outlet,head:()=>({meta:[{name:"robots",content:"noindex, nofollow"},{title:"Commerce admin — Sri Varahi Traders"},{name:"description",content:"Manage Sri Varahi Traders products, variants, inventory, orders, customers and commerce integrations."}]})});
