/**
 * 版本发布脚本
 * 用法: node scripts/release.js <version> [--apk] [--desktop] [--ios] [--all]
 * 例如:
 *   node scripts/release.js 1.1.13          # 构建全部（APK + Desktop + iOS）
 *   node scripts/release.js 1.1.13 --apk    # 只构建 APK
 *   node scripts/release.js 1.1.13 --desktop # 只构建桌面端
 *   node scripts/release.js 1.1.13 --ios     # 只构建 iOS（未签名 IPA）
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// 解析参数
const args = process.argv.slice(2);
const newVersion = args.find((arg) => /^\d+\.\d+\.\d+$/.test(arg));
const buildApk =
    args.includes('--apk') ||
    args.includes('--all') ||
    (!args.includes('--apk') && !args.includes('--desktop') && !args.includes('--ios'));
const buildDesktop =
    args.includes('--desktop') ||
    args.includes('--all') ||
    (!args.includes('--apk') && !args.includes('--desktop') && !args.includes('--ios'));
const buildIos =
    args.includes('--ios') ||
    args.includes('--all') ||
    (!args.includes('--apk') && !args.includes('--desktop') && !args.includes('--ios'));

if (!newVersion) {
    console.error('❌ 请指定版本号，例如: node scripts/release.js 1.1.13');
    console.error(
        '   选项: --apk (只构建APK), --desktop (只构建桌面端), --ios (只构建iOS), --all (全部)'
    );
    process.exit(1);
}

// 验证版本号格式
if (!/^\d+\.\d+\.\d+$/.test(newVersion)) {
    console.error('❌ 版本号格式错误，应为 x.y.z 格式');
    process.exit(1);
}

const ROOT_DIR = path.resolve(__dirname, '..');

console.log(`\n🚀 开始发布版本 ${newVersion}`);
console.log(
    `   构建目标: ${[buildApk && 'APK', buildDesktop && 'Desktop', buildIos && 'iOS'].filter(Boolean).join(' + ')}\n`
);

// 1. 更新 package.json
console.log('📝 更新 package.json...');
const packageJsonPath = path.join(ROOT_DIR, 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const oldVersion = packageJson.version;
packageJson.version = newVersion;
fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
console.log(`   ${oldVersion} → ${newVersion}`);

// 2. 更新 apk-updater.js
console.log('📝 更新 js/update/apk-updater.js...');
const apkUpdaterPath = path.join(ROOT_DIR, 'js/update/apk-updater.js');
let apkUpdaterContent = fs.readFileSync(apkUpdaterPath, 'utf8');
apkUpdaterContent = apkUpdaterContent.replace(
    /let CURRENT_VERSION = '[^']+'/,
    `let CURRENT_VERSION = '${newVersion}'`
);
fs.writeFileSync(apkUpdaterPath, apkUpdaterContent);

// 3. 更新 Android build.gradle
console.log('📝 更新 android/app/build.gradle...');
const buildGradlePath = path.join(ROOT_DIR, 'android/app/build.gradle');
let buildGradleContent = fs.readFileSync(buildGradlePath, 'utf8');

// 计算新的 versionCode（从版本号提取，如 1.1.13 → 14）
const versionParts = newVersion.split('.').map(Number);
const newVersionCode = versionParts[0] * 100 + versionParts[1] * 10 + versionParts[2];

buildGradleContent = buildGradleContent.replace(/versionCode \d+/, `versionCode ${newVersionCode}`);
buildGradleContent = buildGradleContent.replace(
    /versionName "[^"]+"/,
    `versionName "${newVersion}"`
);
fs.writeFileSync(buildGradlePath, buildGradleContent);
console.log(`   versionCode: ${newVersionCode}, versionName: ${newVersion}`);

// 创建 releases 目录
const releaseDir = path.join(ROOT_DIR, `releases/v${newVersion}`);
if (!fs.existsSync(releaseDir)) {
    fs.mkdirSync(releaseDir, { recursive: true });
}

// 辅助函数：获取文件大小
function getFileSizeMB(filePath) {
    const stats = fs.statSync(filePath);
    return (stats.size / (1024 * 1024)).toFixed(2);
}

// ==================== APK 构建 ====================
if (buildApk) {
    // 4a. 同步 Capacitor
    console.log('\n📦 同步 Capacitor 资源...');
    try {
        execSync('npm run cap:sync', { cwd: ROOT_DIR, stdio: 'inherit' });
    } catch (error) {
        console.error('❌ Capacitor 同步失败');
        process.exit(1);
    }

    // 4b. 构建 APK
    console.log('\n🔨 构建 Release APK...');
    try {
        const androidDir = path.join(ROOT_DIR, 'android');
        const gradlewCmd = process.platform === 'win32' ? '.\\gradlew.bat' : './gradlew';
        execSync(`${gradlewCmd} assembleRelease`, {
            cwd: androidDir,
            stdio: 'inherit',
            shell: true
        });
    } catch (error) {
        console.error('❌ APK 构建失败');
        process.exit(1);
    }

    // 4c. 复制 APK 到 releases 目录
    console.log('\n📁 复制 APK 到 releases 目录...');
    const apkSourcePath = path.join(
        ROOT_DIR,
        'android/app/build/outputs/apk/release/app-release.apk'
    );
    const apkDestPath = path.join(releaseDir, 'app-release.apk');

    if (!fs.existsSync(apkSourcePath)) {
        console.error('❌ 找不到构建的 APK 文件');
        process.exit(1);
    }

    fs.copyFileSync(apkSourcePath, apkDestPath);
    console.log(`   ✅ ${apkDestPath}`);
    console.log(`   📊 文件大小: ${getFileSizeMB(apkDestPath)} MB`);
}

// ==================== Desktop 构建 ====================
if (buildDesktop) {
    // 5a. 清理旧的 dist 目录
    const distDir = path.join(ROOT_DIR, 'dist');
    if (fs.existsSync(distDir)) {
        console.log('\n🧹 清理旧的 dist 目录...');
        fs.rmSync(distDir, { recursive: true, force: true });
    }

    // 5b. 构建 Windows 桌面应用
    console.log('\n🔨 构建 Windows 桌面应用...');
    try {
        execSync('npm run dist:win', { cwd: ROOT_DIR, stdio: 'inherit' });
    } catch (error) {
        console.error('❌ 桌面应用构建失败');
        process.exit(1);
    }

    // 5c. 复制桌面应用到 releases 目录
    console.log('\n📁 复制桌面应用到 releases 目录...');

    const setupExe = path.join(distDir, `Webchat-Setup-${newVersion}.exe`);
    const portableExe = path.join(distDir, `Webchat ${newVersion}.exe`);
    const latestYml = path.join(distDir, 'latest.yml');

    if (fs.existsSync(setupExe)) {
        const destSetup = path.join(releaseDir, `Webchat-Setup-${newVersion}.exe`);
        fs.copyFileSync(setupExe, destSetup);
        console.log(`   ✅ ${destSetup}`);
        console.log(`   📊 文件大小: ${getFileSizeMB(destSetup)} MB`);
    } else {
        console.warn('   ⚠️ 找不到安装包文件');
    }

    if (fs.existsSync(portableExe)) {
        const destPortable = path.join(releaseDir, `Webchat-${newVersion}-Portable.exe`);
        fs.copyFileSync(portableExe, destPortable);
        console.log(`   ✅ ${destPortable}`);
        console.log(`   📊 文件大小: ${getFileSizeMB(destPortable)} MB`);
    } else {
        console.warn('   ⚠️ 找不到便携版文件');
    }

    // 复制 latest.yml（用于自动更新）
    if (fs.existsSync(latestYml)) {
        const destLatestYml = path.join(releaseDir, 'latest.yml');
        fs.copyFileSync(latestYml, destLatestYml);
        console.log(`   ✅ ${destLatestYml}`);
        console.log(`   📊 文件大小: ${(fs.statSync(destLatestYml).size / 1024).toFixed(2)} KB`);
    } else {
        console.warn('   ⚠️ 找不到 latest.yml 文件（自动更新功能可能无法使用）');
    }
}

// ==================== iOS 构建 ====================
if (buildIos) {
    // 6a. 同步 Capacitor iOS
    console.log('\n📦 同步 Capacitor iOS 资源...');
    try {
        execSync('npm run cap:sync:ios', { cwd: ROOT_DIR, stdio: 'inherit' });
    } catch (error) {
        console.error('❌ Capacitor iOS 同步失败');
        process.exit(1);
    }

    // 6b. 构建未签名 .app
    console.log('\n🔨 构建 iOS Release（未签名）...');
    const iosProjectDir = path.join(ROOT_DIR, 'ios/App');
    const archivePath = path.join(ROOT_DIR, `releases/v${newVersion}/Webchat.xcarchive`);
    const exportDir = path.join(ROOT_DIR, `releases/v${newVersion}/ios-export`);

    try {
        execSync(
            `xcodebuild archive ` +
                `-project App.xcodeproj ` +
                `-scheme App ` +
                `-configuration Release ` +
                `-archivePath "${archivePath}" ` +
                `CODE_SIGN_IDENTITY="" CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=NO`,
            { cwd: iosProjectDir, stdio: 'inherit', shell: true }
        );
    } catch (error) {
        console.error('❌ iOS 构建失败');
        process.exit(1);
    }

    // 6c. 从 xcarchive 打包未签名 IPA
    console.log('\n📦 打包未签名 IPA...');
    const appPath = path.join(archivePath, 'Products/Applications/App.app');
    const payloadDir = path.join(exportDir, 'Payload');
    const ipaPath = path.join(releaseDir, `Webchat-${newVersion}-unsigned.ipa`);

    if (fs.existsSync(appPath)) {
        if (fs.existsSync(exportDir)) {
            fs.rmSync(exportDir, { recursive: true, force: true });
        }
        fs.mkdirSync(payloadDir, { recursive: true });

        execSync(`cp -r "${appPath}" "${payloadDir}/App.app"`, { shell: true });
        execSync(`cd "${exportDir}" && zip -r "${ipaPath}" Payload`, { shell: true });

        // 清理临时文件
        fs.rmSync(exportDir, { recursive: true, force: true });
        fs.rmSync(archivePath, { recursive: true, force: true });

        console.log(`   ✅ ${ipaPath}`);
        console.log(`   📊 文件大小: ${getFileSizeMB(ipaPath)} MB`);
    } else {
        console.error('❌ 找不到构建的 .app 文件');
        process.exit(1);
    }
}

// ==================== 完成 ====================
console.log(`\n✅ 版本 ${newVersion} 发布完成！\n`);

// 列出生成的文件
console.log('📦 生成的文件:');
const files = fs.readdirSync(releaseDir);
files.forEach((file) => {
    const filePath = path.join(releaseDir, file);
    console.log(`   - ${file} (${getFileSizeMB(filePath)} MB)`);
});

console.log('\n📋 下一步操作:');
console.log(`   1. git add -A && git commit -m "chore: bump version to ${newVersion}"`);
console.log('   2. git push origin Dev');
console.log(`   3. 在 GitHub 创建 Release，上传 releases/v${newVersion}/ 中的文件`);
console.log('');
