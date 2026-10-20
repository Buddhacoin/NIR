#import <Foundation/Foundation.h>
#import <CommonCrypto/CommonDigest.h>
#include <fcntl.h>
#include <errno.h>
#include <limits.h>
#include <sys/stat.h>
#include <unistd.h>

static NSString *hexDigest(const unsigned char *bytes, NSUInteger length) {
    NSMutableString *value = [NSMutableString stringWithCapacity:length * 2];
    for (NSUInteger index = 0; index < length; index++) [value appendFormat:@"%02x", bytes[index]];
    return value;
}

static NSString *fileDigest(NSString *path, NSNumber *expectedSize) {
    int descriptor = open(path.fileSystemRepresentation, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    if (descriptor < 0) return nil;
    struct stat status;
    if (fstat(descriptor, &status) != 0 || !S_ISREG(status.st_mode) ||
        status.st_size != expectedSize.longLongValue || status.st_size > 512LL * 1024 * 1024) {
        close(descriptor); return nil;
    }
    CC_SHA256_CTX context;
    CC_SHA256_Init(&context);
    unsigned char buffer[64 * 1024];
    ssize_t count;
    while ((count = read(descriptor, buffer, sizeof(buffer))) > 0) CC_SHA256_Update(&context, buffer, (CC_LONG)count);
    close(descriptor);
    if (count != 0) return nil;
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256_Final(digest, &context);
    return hexDigest(digest, sizeof(digest));
}

static NSString *canonicalRealPath(NSString *path) {
    char resolved[PATH_MAX];
    return realpath(path.fileSystemRepresentation, resolved) ?
        [[NSFileManager defaultManager] stringWithFileSystemRepresentation:resolved length:strlen(resolved)] : nil;
}

static BOOL exactKeys(NSDictionary *value, NSArray<NSString *> *keys) {
    return [[NSSet setWithArray:value.allKeys] isEqualToSet:[NSSet setWithArray:keys]];
}

static NSString *lexicalPath(NSString *path) {
    if (![path isKindOfClass:NSString.class] || !path.isAbsolutePath) return nil;
    NSMutableArray<NSString *> *parts = [NSMutableArray array];
    for (NSString *part in [path componentsSeparatedByString:@"/"]) {
        if (part.length == 0 || [part isEqualToString:@"."]) continue;
        if ([part isEqualToString:@".."]) {
            // POSIX absolute paths and Node path.resolve clamp excess parent
            // components at filesystem root rather than becoming invalid.
            if (parts.count > 0) [parts removeLastObject];
        } else [parts addObject:part];
    }
    return [@"/" stringByAppendingString:[parts componentsJoinedByString:@"/"]];
}

static BOOL verifyDependencies(NSArray *dependencies) {
    if (![dependencies isKindOfClass:NSArray.class] || dependencies.count > 512) return NO;
    NSMutableSet<NSString *> *paths = [NSMutableSet setWithCapacity:dependencies.count];
    unsigned long long total = 0;
    for (NSDictionary *binding in dependencies) {
        if (![binding isKindOfClass:NSDictionary.class] || !exactKeys(binding,
            @[@"logicalPath", @"realPath", @"sha256", @"size"])) return NO;
        NSString *logical = binding[@"logicalPath"], *expectedReal = binding[@"realPath"];
        NSString *digest = binding[@"sha256"];
        NSNumber *size = binding[@"size"];
        if (![logical isKindOfClass:NSString.class] || !logical.isAbsolutePath ||
            ![expectedReal isKindOfClass:NSString.class] || !expectedReal.isAbsolutePath ||
            ![digest isKindOfClass:NSString.class] || digest.length != 64 ||
            ![size isKindOfClass:NSNumber.class] || [paths containsObject:logical] ||
            ![canonicalRealPath(logical) isEqualToString:expectedReal]) return NO;
        [paths addObject:logical];
        if (size.unsignedLongLongValue > 512ULL * 1024 * 1024 ||
            total + size.unsignedLongLongValue > 2ULL * 1024 * 1024 * 1024) return NO;
        total += size.unsignedLongLongValue;
        if (![[fileDigest(expectedReal, size) lowercaseString] isEqualToString:digest]) return NO;
    }
    return YES;
}

static BOOL verifyMissingDependencies(NSArray *paths) {
    if (![paths isKindOfClass:NSArray.class] || paths.count > 512) return NO;
    NSMutableSet<NSString *> *seen = [NSMutableSet setWithCapacity:paths.count];
    for (NSString *path in paths) {
        if (![path isKindOfClass:NSString.class] || !path.isAbsolutePath ||
            [seen containsObject:path]) return NO;
        [seen addObject:path];
        struct stat status;
        errno = 0;
        if (lstat(path.fileSystemRepresentation, &status) == 0 || errno != ENOENT) return NO;
    }
    return YES;
}

static BOOL verifyExecutable(NSDictionary *binding) {
    if (![binding isKindOfClass:NSDictionary.class] || !exactKeys(binding,
        @[@"logicalPath", @"realPath", @"links", @"dependencies", @"missingDependencies",
          @"sha256", @"size"])) return NO;
    NSString *logical = binding[@"logicalPath"], *expectedReal = binding[@"realPath"];
    NSArray *links = binding[@"links"];
    NSNumber *size = binding[@"size"];
    NSString *digest = binding[@"sha256"];
    NSArray *dependencies = binding[@"dependencies"];
    NSArray *missingDependencies = binding[@"missingDependencies"];
    if (![logical isKindOfClass:NSString.class] || !logical.isAbsolutePath ||
        ![expectedReal isKindOfClass:NSString.class] || !expectedReal.isAbsolutePath ||
        ![links isKindOfClass:NSArray.class] || ![size isKindOfClass:NSNumber.class] ||
        ![digest isKindOfClass:NSString.class] || digest.length != 64) return NO;
    NSString *cursor = lexicalPath(logical);
    for (NSDictionary *link in links) {
        if (![link isKindOfClass:NSDictionary.class] || !exactKeys(link, @[@"path", @"target"]) ||
            ![cursor isEqualToString:link[@"path"]]) return NO;
        struct stat status;
        if (lstat(cursor.fileSystemRepresentation, &status) != 0 || !S_ISLNK(status.st_mode)) return NO;
        char target[PATH_MAX];
        ssize_t length = readlink(cursor.fileSystemRepresentation, target, sizeof(target));
        if (length < 0 || length >= (ssize_t)sizeof(target)) return NO;
        NSString *actual = [[NSString alloc] initWithBytes:target length:(NSUInteger)length encoding:NSUTF8StringEncoding];
        if (!actual || ![actual isEqualToString:link[@"target"]]) return NO;
        cursor = lexicalPath([actual hasPrefix:@"/"] ? actual :
            [cursor.stringByDeletingLastPathComponent stringByAppendingPathComponent:actual]);
    }
    if (![canonicalRealPath(logical) isEqualToString:expectedReal] ||
        ![cursor isEqualToString:expectedReal]) return NO;
    return [[fileDigest(expectedReal, size) lowercaseString] isEqualToString:digest] &&
        verifyDependencies(dependencies) && verifyMissingDependencies(missingDependencies);
}

static NSString *encoded(NSString *value) {
    NSData *bytes = [value dataUsingEncoding:NSUTF8StringEncoding];
    if (!bytes || bytes.length == 0 || bytes.length > 4096 || [value containsString:@"\n"]) return nil;
    return [bytes base64EncodedStringWithOptions:0];
}

static BOOL verifyEnvironment(NSDictionary *binding, NSString *pythonReal) {
    if (![binding isKindOfClass:NSDictionary.class] || !exactKeys(binding,
        @[@"root", @"entries", @"bytes", @"brokenLinks", @"externalLinks", @"treeSha256"])) return NO;
    NSString *root = binding[@"root"], *expectedHash = binding[@"treeSha256"];
    NSNumber *expectedEntries = binding[@"entries"], *expectedBytes = binding[@"bytes"];
    NSArray *allowed = binding[@"externalLinks"];
    NSArray *allowedBroken = binding[@"brokenLinks"];
    struct stat rootStatus;
    if (![root isKindOfClass:NSString.class] || !root.isAbsolutePath ||
        lstat(root.fileSystemRepresentation, &rootStatus) != 0 || !S_ISDIR(rootStatus.st_mode) ||
        ![canonicalRealPath(root) isEqualToString:root] || ![allowed isKindOfClass:NSArray.class] ||
        ![allowedBroken isKindOfClass:NSArray.class] ||
        ![expectedHash isKindOfClass:NSString.class] || expectedHash.length != 64) return NO;
    NSArray<NSString *> *paths = [[[NSFileManager defaultManager] enumeratorAtPath:root] allObjects];
    if (paths.count != expectedEntries.unsignedLongLongValue || paths.count > 50000) return NO;
    NSMutableArray<NSString *> *records = [NSMutableArray arrayWithCapacity:paths.count];
    NSMutableSet<NSString *> *external = [NSMutableSet set];
    NSMutableSet<NSString *> *broken = [NSMutableSet set];
    unsigned long long total = 0;
    for (NSString *relative in paths) {
        if (![relative isKindOfClass:NSString.class] || !encoded(relative)) return NO;
        NSString *encodedRelative = encoded(relative);
        NSString *path = [root stringByAppendingPathComponent:relative];
        struct stat status;
        if (lstat(path.fileSystemRepresentation, &status) != 0) return NO;
        if (S_ISDIR(status.st_mode)) [records addObject:[NSString stringWithFormat:@"D\t%@\n", encodedRelative]];
        else if (S_ISREG(status.st_mode)) {
            if (status.st_size > 512LL * 1024 * 1024 || total + status.st_size > 8ULL * 1024 * 1024 * 1024) return NO;
            total += status.st_size;
            NSString *digest = fileDigest(path, @(status.st_size));
            if (!digest) return NO;
            [records addObject:[NSString stringWithFormat:@"F\t%@\t%lld\t%@\n", encodedRelative, status.st_size, digest]];
        } else if (S_ISLNK(status.st_mode)) {
            char targetBytes[PATH_MAX];
            ssize_t length = readlink(path.fileSystemRepresentation, targetBytes, sizeof(targetBytes));
            if (length < 0 || length >= (ssize_t)sizeof(targetBytes)) return NO;
            NSString *target = [[NSString alloc] initWithBytes:targetBytes length:(NSUInteger)length encoding:NSUTF8StringEncoding];
            NSString *encodedTarget = target ? encoded(target) : nil;
            if (!encodedTarget) return NO;
            NSString *resolved = canonicalRealPath(path);
            if (!resolved) [broken addObject:relative];
            NSString *rootPrefix = [root stringByAppendingString:@"/"];
            if (resolved && ![resolved hasPrefix:rootPrefix] && ![resolved isEqualToString:root]) {
                if (![resolved isEqualToString:pythonReal] || ![relative hasPrefix:@"bin/"]) return NO;
                [external addObject:relative];
            }
            [records addObject:[NSString stringWithFormat:@"L\t%@\t%@\n", encodedRelative, encodedTarget]];
        } else return NO;
    }
    if (total != expectedBytes.unsignedLongLongValue ||
        ![external isEqualToSet:[NSSet setWithArray:allowed]] ||
        ![broken isEqualToSet:[NSSet setWithArray:allowedBroken]]) return NO;
    [records sortUsingSelector:@selector(compare:)];
    CC_SHA256_CTX context;
    CC_SHA256_Init(&context);
    for (NSString *record in records) {
        NSData *bytes = [record dataUsingEncoding:NSUTF8StringEncoding];
        CC_SHA256_Update(&context, bytes.bytes, (CC_LONG)bytes.length);
    }
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256_Final(digest, &context);
    return [[hexDigest(digest, sizeof(digest)) lowercaseString] isEqualToString:expectedHash];
}

static BOOL verifyRuntime(NSString *configuration) {
    NSData *bytes = [NSData dataWithContentsOfFile:configuration options:NSDataReadingMappedIfSafe error:nil];
    NSDictionary *runtime = bytes ? [NSJSONSerialization JSONObjectWithData:bytes options:0 error:nil] : nil;
    if (![runtime isKindOfClass:NSDictionary.class] || !exactKeys(runtime,
        @[@"format", @"nodeExecutable", @"pythonBaseEnvironment", @"pythonExecutable", @"pythonEnvironment"]) ||
        ![runtime[@"format"] isEqualToString:@"nir-local-runtime-binding-v2"] ||
        !verifyExecutable(runtime[@"nodeExecutable"]) || !verifyExecutable(runtime[@"pythonExecutable"]) ||
        !verifyEnvironment(runtime[@"pythonBaseEnvironment"], runtime[@"pythonExecutable"][@"realPath"])) return NO;
    id environment = runtime[@"pythonEnvironment"];
    return environment == NSNull.null || verifyEnvironment(environment, runtime[@"pythonExecutable"][@"realPath"]);
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc != 2 || !verifyRuntime(@(argv[1]))) {
            fputs("runtime binding verification failed\n", stderr);
            return 1;
        }
        return 0;
    }
}
