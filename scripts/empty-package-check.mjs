const packageName = process.env.npm_package_name ?? "workspace package";
const command = process.env.npm_lifecycle_event ?? "workspace check";

console.log(`${packageName}: no Stage 0 source; ${command} has nothing to run.`);
