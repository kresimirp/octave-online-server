/*
 * Copyright © 2018, Octave Online LLC
 *
 * This file is part of Octave Online Server.
 *
 * Octave Online Server is free software: you can redistribute it and/or
 * modify it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the License,
 * or (at your option) any later version.
 *
 * Octave Online Server is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
 * or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public
 * License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with Octave Online Server.  If not, see
 * <https://www.gnu.org/licenses/>.
 */

///<reference path='boris-typedefs/node/node.d.ts'/>
///<reference path='boris-typedefs/socket.io/socket.io.d.ts'/>
///<reference path='boris-typedefs/async/async.d.ts'/>
///<reference path='typedefs/easy-no-password.d.ts'/>
///<reference path='typedefs/ot.d.ts'/>
///<reference path='typedefs/idestroyable.d.ts'/>
///<reference path='typedefs/iworkspace.ts'/>
///<reference path='typedefs/iuser.ts'/>
///<reference path='typedefs/ibucket.ts'/>

import User = require("./user_model");
import Bucket = require("./bucket_model");
import Config = require("./config");
import BackServerHandler = require("./back_server_handler");
import NormalWorkspace = require("./workspace_normal");
import SharedWorkspace = require("./workspace_shared");
import ChildProcess = require("child_process");
import Ot = require("ot");
import Async = require("async");

const enp = require("easy-no-password")(Config.auth.easy.secret);

interface ISocketCustom extends SocketIO.Socket {
	handler: SocketHandler;
	removeAllListeners():ISocketCustom;
}

class SocketHandler implements IDestroyable {
	public socket:ISocketCustom;
	public otServer:Ot.Server;
	public back:BackServerHandler;
	public workspace:IWorkspace;
	public user:IUser = null;
	public bucketId:string = null;
	public sessCode:string;
	public destroyed:boolean = false;

	public static onConnection(socket:SocketIO.Socket) {
		var handler = new SocketHandler(socket);
		handler.socket.handler = handler;
	}

	constructor(socket:SocketIO.Socket) {
		var self = this;

		// Set up the socket
		this.socket = <ISocketCustom> socket;
		this.log("New Connection", this.socket.handshake.address);
		this.socket.emit("init");

		// Set up Redis connection to back server
		this.back = new BackServerHandler();

		// Add event listeners
		this.listen();

		// Startup tasks
		Async.auto({

			// 1. Load user from database
			user: (next) => {
				var sess = self.socket.request.session;
				var userId = sess && sess.passport && sess.passport.user;

				if (userId) User.findById(userId, next);
				else next(null, null);
			},

			// 2. User requested to connect
			init: (next) => {
				self.socket.once("init", (data) => {
					next(null, data);
				});
			},

			// Callback (depends on 1 and 2)
			init_session: ["user", "init", (next, {user, init}) => {
				if (self.destroyed) return;

				self.user = user;

				// Fork to load instructor data and buckets
				this.loadInstructor();
				this.loadUserBuckets();
				this.touchUser();

				// Process the user's requested action
				var action = init && init.action;
				var info = init && init.info;
				var oldSessCode = init && init.sessCode;
				var skipCreate = init && init.skipCreate;
				if (action === "session" && !oldSessCode) {
					oldSessCode = info; // backwards compat.
				}

				switch (action) {
					case "workspace":
						if (!info) return;
						this.log("Attaching to colaborative workspace:", info);
						this.workspace = new SharedWorkspace("default", info);
						break;

					case "student":
						if (!info) return;
						// Note: this is not necesarilly a student.  It can be any user.
						this.log("Attaching to a student's workspace:", info)
						this.workspace = new SharedWorkspace("student", info);
						break;

					case "bucket":
						if (!info) return;
						this.log("Attaching to a bucket:", info);
						this.workspace = new NormalWorkspace(oldSessCode, user, <string> info);
						break;

					case "session":
					default:
						if (user && user.share_key) {
							this.log("Attaching as host to student's workspace:", user.share_key);
							this.workspace = new SharedWorkspace("host", user);
						} else {
							this.log("Attaching to default workspace with sessCode", info);
							this.workspace = new NormalWorkspace(oldSessCode, user, null);
						}
						break;
				}

				this.listen();
				if (action === "bucket") {
					this.bucketId = <string> info;
					this.loadBucket(skipCreate);
				} else if (!skipCreate) {
					this.workspace.beginOctaveRequest();
				}

				// Continue down the chain (does not do anything currently)
				next(null, null);
			}]

		}, (err) => {
			// Error Handler
			if (err) {
				this.log("ASYNC ERROR", err);
			}
		});
	}

	private listen() {
		// Prevent duplicate listeners
		this.unlisten();

		// Make listeners on the socket
		this.socket.on("*", this.onDataD);
		this.socket.on("disconnect", this.onDestroyD);

		// Make listeners on Redis
		this.back.on("data", this.onDataU);
		this.back.on("destroy-u", this.onDestroyU);

		// Make listeners on Workspace
		if (this.workspace) {
			this.workspace.on("data", this.onDataW);
			this.workspace.on("message", this.sendMessage);
			this.workspace.on("sesscode", this.setSessCode);
			this.workspace.on("back", this.onDataWtoU);
			this.workspace.on("log", this.onLogW);
			this.workspace.subscribe();
		}

		// Let Redis have listeners too
		this.back.subscribe();
	}

	private unlisten():void {
		this.socket.removeAllListeners();
		this.back.removeAllListeners();
		this.back.unsubscribe();
		if (this.workspace) {
			this.workspace.removeAllListeners();
			this.workspace.unsubscribe();
		}
	}

	private log(..._args:any[]):void {
		var args = Array.prototype.slice.apply(arguments);
		args.unshift("[" + this.socket.id + "]");
		console.log.apply(this, args);
	}

	// Convenience function to post a message in the client's console window
	private sendMessage = (message:string):void => {
		// Log to console for backwards compatibility with older clients.
		// TODO: Remove this and send the alert box only
		this.socket.emit("data", {
			type: "stdout",
			data: message+"\n"
		});
		this.socket.emit("alert", message);
	};

	//// MAIN LISTENER FUNCTIONS ////

	// When the client disconnects (destroyed from downstream)
	private onDestroyD = ():void => {
		this.log("Client Disconnect");
		if (this.workspace) this.workspace.destroyD("Client Disconnect");
		this.unlisten();
	};

	// When the back server exits (destroyed from upstream)
	private onDestroyU = (message:string):void => {
		this.log("Upstream Destroyed:", message);
		this.socket.emit("destroy-u", message);
		this.back.setSessCode(null);
		if (this.workspace) this.workspace.destroyU(message);
	};

	// When the client sends a message (data from downstream)
	private onDataD = (obj) => {
		var name = obj.data[0] || "";
		var data = obj.data[1] || null;

		// Check for name matches
		switch(name){
			case "init":
				return;
			case "enroll":
				this.onEnroll(data);
				return;
			case "update_students":
				this.onUpdateStudents(data);
				return;
			case "oo.unenroll_student":
				this.onUnenrollStudent(data);
				return;
			case "oo.reenroll_student":
				this.onReenrollStudent(data);
				return;
			case "oo.ping":
				this.onPing(data);
				return;
			case "oo.toggle_sharing":
				this.onToggleSharing(data);
				return;
			case "oo.reconnect":
				this.onOoReconnect();
				return;
			case "oo.set_password":
				this.onSetPassword(data);
				return;
			case "oo.delete_bucket":
				this.onDeleteBucket(data);
				return;

			default:
				break;
		}

		// Check for prefix matches
		switch(name.substr(0,3)){
			case "ot.":
			case "ws.":
				if (this.workspace) this.workspace.dataD(name, data);
				return;
		}

		// Intercept some commands and fork them into the workspace
		if (name === "data" && this.workspace) this.workspace.dataD(name, data);
		if (name === "save" && this.workspace) this.workspace.dataD(name, data);

		// Send everything else upstream to the back server
		this.back.dataD(name, data);
	};

	// When the back server sends a message (data from upstream)
	// Let everything continue downstream to the client
	private onDataU = (name, data) => {
		if (this.workspace) this.workspace.dataU(name, data);

		switch(name){
			case "bucket-repo-created":
				this.onBucketCreated(data);
				return;
		}

		this.socket.emit(name, data);
	};

	// When the workspace sends a message (data from workspace)
	// Let everything continue downstream to the client
	private onDataW = (name, data) => {
		this.socket.emit(name, data);
	};

	// When the workspace instance wants to log something
	private onLogW = (data) => {
		this.log.apply(this, data);
	};

	//// OTHER UTILITY FUNCTIONS ////

	private loadInstructor = ():void => {
		if (!this.user || !this.user.instructor || !this.user.instructor.length)
			return;

		var programs = this.user.instructor;
		programs.forEach((program:string) => {
			User.find({ program: program }, (err,users) => {
				this.socket.emit("instructor", {
					program: program,
					users: users
				})
			});
		});
	}

	private loadUserBuckets = ():void => {
		if (!this.user) return;
		Bucket.find({ user_id: this.user._id }, (err, buckets) => {
			if (err) {
				this.log("LOAD USER BUCKETS ERROR", err);
				return;
			}
			this.log("Loaded", buckets.length, "buckets for user", this.user.consoleText);
			this.socket.emit("all-buckets", { buckets });
		});
	}

	private touchUser = ():void => {
		if (!this.user) return;
		this.user.touchLastActivity((err) => {
			if (err) {
				this.log("TOUCH ACTIVITY ERROR", err);
				return;
			}
		});
	}

	private loadBucket = (skipCreate: boolean):void => {
		if (!this.bucketId) return;
		Bucket.findOne({ bucket_id: this.bucketId }, (err, bucket) => {
			if (err) {
				this.log("LOAD BUCKET ERROR", err);
				this.sendMessage("Encountered error while initializing bucket.");
				return;
			}
			if (!bucket) {
				this.sendMessage("Unable to find bucket: " + this.bucketId);
				this.socket.emit("destroy-u", "Unknown Bucket");
				this.workspace = null;
				return;
			}
			this.log("Bucket loaded:", bucket.bucket_id);
			this.socket.emit("bucket-info", bucket);
			if (!skipCreate) {
				this.workspace.beginOctaveRequest();
			}
		});
	}

	private onSetPassword = (obj)=> {
		if (!obj) return;
		if (!this.user) return;
		this.user.setPassword(obj.new_pwd, (err) => {
			if (err) return this.log("SET PASSWORD ERROR", err);
			this.sendMessage("Your password has been changed.");
		});
	}

	private onBucketCreated = (obj) => {
		if (!obj) return;
		if (!obj.bucket_id) return;
		if (!this.user) {
			this.log("ERROR: No user but got bucket-created message!", obj.bucket_id);
			return;
		}

		var bucket = new Bucket();
		this.log("Creating bucket:", obj.bucket_id, this.user.consoleText);
		bucket.bucket_id = obj.bucket_id;
		bucket.user_id = this.user._id;
		bucket.main = obj.main;
		bucket.save((err) => {
			if (err) return this.log("ERROR creating bucket:", err);
			this.socket.emit("bucket-created", { bucket });
		});
	}

	private onDeleteBucket = (obj) => {
		if (!obj) return;
		if (!obj.bucket_id) return;
		if (!this.user) return;
		this.log("Deleting bucket:", obj.bucket_id);
		// NOTE: This deletes the bucket from mongo, but not from the file server.  A batch job can be run to delete bucket repos that are not in sync with mongo.
		Bucket.findOne({ bucket_id: obj.bucket_id }, (err, bucket) => {
			if (err) {
				this.log("LOAD BUCKET ERROR", err);
				this.sendMessage("Encountered error while finding bucket.");
				return;
			}
			if (!bucket) {
				this.sendMessage("Unable to find bucket; did you already delete it?");
				return;
			}
			if (!this.user._id.equals(bucket.user_id)) {
				this.log("ERROR: Bad owner:", bucket.user_id, this.user.consoleText);
				this.sendMessage("You are not the owner of that bucket");
				return;
			}
			bucket.remove((err, bucket) => {
				if (err) {
					this.log("REMOVE BUCKET ERROR", err);
					this.sendMessage("Encountered error while removing bucket.");
					return;
				}
				this.socket.emit("bucket-deleted", {
					bucket_id: obj.bucket_id
				});
			});
		});
	}

	private onOoReconnect = ():void => {
		if (this.workspace) {
			this.workspace.beginOctaveRequest();
		} else {
			this.socket.emit("destroy-u", "Invalid Session");
		}
	};

	private setSessCode = (sessCode: string): void => {
		// We have our sessCode.
		this.log("SessCode", sessCode);
		this.back.setSessCode(sessCode);
		this.socket.emit("sesscode", {
			sessCode: sessCode
		});
		if (this.workspace) this.workspace.sessCode = sessCode;
	};

	private onDataWtoU = (name:string, value:any):void => {
		this.back.dataD(name, value);
	};

	//// ENROLLING AND STUDENTS LISTENER FUNCTIONS ////

	private onEnroll = (obj)=> {
		if (!this.user || !obj) return;
		var program = obj.program;
		if (!program) return;
		this.log("Enrolling", this.user.consoleText, "in program", program);
		this.user.program = program;
		this.user.save((err)=> {
			if (err) return this.log("MONGO ERROR", err);
			this.sendMessage("Successfully enrolled");
		});
	};

	private onUpdateStudents = (obj)=> {
		if (!obj) return;
		return this.sendMessage("The update_students command has been replaced.\nOpen a support ticket for more information.");
	};

	private onUnenrollStudent = (obj)=> {
		if (!obj) return;
		if (!obj.userId) return;
		User.findById(obj.userId, (err, student)=> {
			if (err) return this.log("MONGO ERROR", err);
			if (this.user.instructor.indexOf(student.program) === -1) return this.log("Warning: illegal call to unenroll student");
			this.log("Un-enrolling", this.user.consoleText, "from program", student.program);
			student.program = "default";
			student.save((err1) =>{
				if (err1) return this.log("MONGO ERROR", err1);
				this.sendMessage("Student successfully unenrolled: " + student.displayName);
			});
		});
	}

	private onReenrollStudent = (obj)=> {
		if (!obj) return;
		if (!obj.userId) return;
		if (!obj.program) return;
		if (this.user.instructor.indexOf(obj.program) === -1) {
			this.sendMessage("Student not re-enrolled: Cannot use the course code " + obj.program);
			return this.log("Warning: illegal call to re-enroll student");
		}
		User.findById(obj.userId, (err, student)=> {
			if (err) return this.log("ERROR ON UNENROLL STUDENT", err);
			if (this.user.instructor.indexOf(student.program) === -1) return this.log("Warning: illegal call to reenroll student");
			this.log("Re-enrolling", this.user.consoleText, "from program", student.program, "to program", obj.program);
			student.program = obj.program;
			student.save((err1) =>{
				if (err1) return this.log("MONGO ERROR", err1);
				this.sendMessage("Student successfully re-enrolled: " + student.displayName);
			});
		});
	}

	private onPing = (obj)=> {
		if (!obj) return;
		this.socket.emit("oo.pong", {
			startTime: parseInt(obj.startTime)
		});
	};

	private onToggleSharing = (obj)=> {
		if (!this.user || !obj) return;
		var enabled = obj.enabled;

		if (!enabled && this.user.program && this.user.program !== "default") {
			this.sendMessage("You must unenroll before disabling sharing.\nTo unenroll, run the command \"enroll('default')\".");
		} else if (enabled) {
			this.user.createShareKey((err)=> {
				if (err) this.log("MONGO ERROR", err);
				this.socket.emit("reload", {});
			});
		} else {
			if (this.workspace) this.workspace.destroyD("Sharing Disabled");
			this.user.removeShareKey((err)=> {
				if (err) this.log("MONGO ERROR", err);
				this.socket.emit("reload", {});
			});
		}
	};
}

export = SocketHandler;